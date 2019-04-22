/** *****************************************************************************
 * Licensed Materials - Property of IBM
 * (c) Copyright IBM Corporation 2018, 2019. All Rights Reserved.
 *
 * Note to U.S. Government Users Restricted Rights:
 * Use, duplication or disclosure restricted by GSA ADP Schedule
 * Contract with IBM Corp.
 ****************************************************************************** */

import express from 'express';
import { graphqlExpress, graphiqlExpress } from 'apollo-server-express';
import { isInstance as isApolloErrorInstance, formatError as formatApolloError } from 'apollo-errors';
import bodyParser from 'body-parser';
import { app as inspect } from '@icp/security-middleware';
import morgan from 'morgan';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

import logger from './lib/logger';

import KubeConnector from './connectors/kube';
import GremlinConnector from './connectors/gremlin';
import RedisGraphConnector from './connectors/redisGraph';

import ApplicationModel from './models/application';
import ClusterModel from './models/cluster';
import GenericModel from './models/generic';
import QueryModel from './models/userquery';
import ComplianceModel from './models/compliance';
import HelmModel from './models/helm';
import MongoModel from './models/mongo';
import ResourceViewModel from './models/resourceview';
import SearchModel from './models/search';

import createMockKubeHTTP from './mocks/kube-http';
import MockSearchConnector from './mocks/search';
import schema from './schema/';
import config from '../../config';
import authMiddleware from './lib/auth-middleware';

export const GRAPHQL_PATH = `${config.get('contextPath')}/graphql`;
export const GRAPHIQL_PATH = `${config.get('contextPath')}/graphiql`;

const isProd = config.get('NODE_ENV') === 'production';
const isTest = config.get('NODE_ENV') === 'test';

const formatError = (error) => {
  const { originalError } = error;
  if (isApolloErrorInstance(originalError)) {
    logger.error(JSON.stringify(error.originalError, null, 2));
  }
  return formatApolloError(error);
};

const graphQLServer = express();
graphQLServer.use(compression());

const requestLogger = isProd ?
  morgan('combined', {
    skip: (req, res) => res.statusCode < 400,
  })
  : morgan('dev');

graphQLServer.use('*', helmet(), requestLogger, cookieParser());

graphQLServer.get('/livenessProbe', (req, res) => {
  res.send(`Testing livenessProbe --> ${new Date().toLocaleString()}`);
});

graphQLServer.get('/readinessProbe', (req, res) => {
  res.send(`Testing readinessProbe --> ${new Date().toLocaleString()}`);
});

const auth = [];

if (isProd) {
  logger.info('Authentication enabled');
  auth.push(inspect, authMiddleware());
} else {
  auth.push(authMiddleware({ shouldLocalAuth: true }));
  graphQLServer.use(GRAPHIQL_PATH, graphiqlExpress({ endpointURL: GRAPHQL_PATH }));
}

if (isTest) {
  logger.info('Running in mock mode');
  logger.info('Using Mocked search connector.');
} else if (config.get('useRedisBackend') === true || config.get('useRedisBackend') === 'true') {
  logger.info('Using RedisGraph search connector.');
} else {
  logger.info('Using Gremlin search connector.');
}

graphQLServer.use(...auth);
graphQLServer.use(GRAPHQL_PATH, bodyParser.json(), graphqlExpress(async (req) => {
  let kubeHTTP;
  if (isTest) {
    kubeHTTP = createMockKubeHTTP();
  }

  const namespaces = req.user.namespaces.map(ns => ns.namespaceId);

  const kubeConnector = new KubeConnector({
    token: req.kubeToken,
    httpLib: kubeHTTP,
    namespaces,
  });

  let searchConnector;
  if (isTest) {
    searchConnector = new MockSearchConnector();
  } else if (config.get('useRedisBackend') === true || config.get('useRedisBackend') === 'true') {
    searchConnector = new RedisGraphConnector({ rbac: namespaces, req });
  } else {
    searchConnector = new GremlinConnector({ rbac: namespaces, req });
  }

  const context = {
    req,
    applicationModel: new ApplicationModel({ kubeConnector }),
    clusterModel: new ClusterModel({ kubeConnector }),
    genericModel: new GenericModel({ kubeConnector }),
    queryModel: new QueryModel({ kubeConnector, req }),
    complianceModel: new ComplianceModel({ kubeConnector }),
    helmModel: new HelmModel({ kubeConnector }),
    mongoModel: new MongoModel(config.get('mongodbUrl'), { namespaces }),
    resourceViewModel: new ResourceViewModel({ kubeConnector }),
    searchModel: new SearchModel({ searchConnector }),
  };

  return { formatError, schema, context };
}));

export default graphQLServer;
