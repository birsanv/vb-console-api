/** *****************************************************************************
 * Licensed Materials - Property of IBM
 * (c) Copyright IBM Corporation 2018. All Rights Reserved.
 *
 * Note to U.S. Government Users Restricted Rights:
 * Use, duplication or disclosure restricted by GSA ADP Schedule
 * Contract with IBM Corp.
 ****************************************************************************** */

import _ from 'lodash';
import yaml from 'js-yaml';
import { unflatten } from 'flat';
import KubeModel from './kube';
import logger from '../lib/logger';

function selectNamespace(namespaces) {
  return namespaces.find(ns => ns === 'default') || namespaces[0];
}

export default class HelmModel extends KubeModel {
  constructor(params) {
    super(params);
    this.resourceViewNamespace = selectNamespace(this.namespaces);
  }

  async getReleases() {
    const response = await this.kubeConnector.resourceViewQuery('releases', this.resourceViewNamespace);
    const results = _.get(response, 'status.results', {});
    return Object.keys(results).reduce((accum, clusterName) => {
      const rels = response.status.results[clusterName].items;

      rels.map(rel => accum.push({
        chartName: rel.spec.chartName,
        chartVersion: rel.spec.chartVersion,
        namespace: rel.spec.namespace,
        status: rel.spec.status,
        version: rel.spec.version,
        name: rel.metadata.name,
        cluster: clusterName,
        lastDeployed: new Date(rel.spec.lastDeployed).getTime() / 1000,
      }));

      return accum;
    }, []);
  }

  async installHelmChart({
    chartURL, destinationClusters, namespace, releaseName, values,
  }) {
    const vals = JSON.parse(values.replace(/'/g, '"'));
    const valuesUnflat = unflatten(vals);
    const valuesYaml = yaml.safeDump(valuesUnflat);
    const valuesEncoded = Buffer.from(valuesYaml).toString('base64');

    return destinationClusters.map(async ({ name: clusterName, namespace: workNamespace }) => {
      const jsonBody = {
        apiVersion: 'mcm.ibm.com/v1alpha1',
        kind: 'Work',
        metadata: {
          name: releaseName,
          namespace: workNamespace,
        },
        spec: {
          cluster: {
            name: clusterName,
          },
          type: 'Deployer',
          helm: {
            chartURL,
            namespace,
            values: valuesEncoded,
          },
        },
      };

      const response = await this.kubeConnector.post(`/apis/mcm.ibm.com/v1alpha1/namespaces/${workNamespace}/works`, jsonBody);
      if (response.code || response.message) {
        logger.error(`MCM ERROR ${response.code} - ${response.message}`);
        return [{
          code: response.code,
          message: response.message,
        }];
      }

      return {
        name: response.metadata.name,
        namespace: response.spec.helm.namespace,
        status: response.status.type,
        cluster: response.spec.cluster.name,
      };
    });
  }

  // FIXME: This is not currently implemented as we are unable to delete the
  // "default" cluster releases To avoid confusion the remove action has been
  // removed from releases table.
  async deleteRelease(input) {
    // TODO: Zack L - Need to make sure releases installed remotly always begin with md- in name.
    // currently have to strip the md- so name matches the work created for the release
    const deploymentName = input.name.substring(3);
    const response = await this.kubeConnector.delete(`/apis/mcm.ibm.com/v1alpha1/namespaces/mcm-${input.cluster}/works/${deploymentName}`);
    if (response.code || response.message) {
      logger.error(`MCM ERROR ${response.code} - ${response.message}`);
      return [{
        code: response.code,
        message: response.message,
      }];
    }

    return [{
      name: response.metadata.name,
      namespace: response.spec.helm.namespace,
      status: response.status.type,
      cluster: response.spec.cluster.name,
    }];
  }

  async getCharts() {
    const response = await this.kubeConnector.get('/apis/mcm.ibm.com/v1alpha1/helmrepos');
    if (response.code || response.message) {
      logger.error(`MCM ERROR ${response.code} - ${response.message}`);
      return [];
    }
    const charts = [];
    response.items.forEach((cluster) => {
      const rName = cluster.metadata.name;
      if (cluster.status.charts) {
        const repo = Object.values(cluster.status.charts);
        repo.forEach((chart) => {
          charts.push({
            repoName: rName,
            name: chart.chartVersions[0].name,
            version: chart.chartVersions[0].version,
            urls: chart.chartVersions[0].urls,
          });
        });
      }
    });
    return charts;
  }

  async getRepos() {
    const response = await this.kubeConnector.get('/apis/mcm.ibm.com/v1alpha1/helmrepos');
    if (response.code || response.message) {
      logger.error(`MCM ERROR ${response.code} - ${response.message}`);
      return [];
    }
    return response.items.map(cluster => ({
      Name: cluster.metadata.name,
      URL: cluster.spec.url,
    }));
  }

  async setRepo(input) {
    const jsonBody = {
      apiVersion: 'mcm.ibm.com/v1alpha1',
      kind: 'HelmRepo',
      metadata: {
        name: input.Name,
      },
      spec: {
        url: input.URL,
      },
    };
    const response = await this.kubeConnector.post('/apis/mcm.ibm.com/v1alpha1/namespaces/default/helmrepos', jsonBody);
    if (response.code || response.message) {
      logger.error(`MCM ERROR ${response.code} - ${response.message}`);
      return [];
    }
    return {
      Name: response.metadata.name,
      URL: response.spec.url,
    };
  }

  async deleteRepo(input) {
    const response = await this.kubeConnector.delete(`/apis/mcm.ibm.com/v1alpha1/namespaces/default/helmrepos/${input.Name}`);
    if (response.code || response.message) {
      logger.error(`MCM ERROR ${response.code} - ${response.message}`);
      return [];
    }
    return {
      Name: response.metadata.name,
      URL: response.spec.url,
    };
  }
}
