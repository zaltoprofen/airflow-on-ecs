#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { AirflowOnEcsStack } from '../lib/airflow-on-ecs-stack';
import { NetworkStack } from '../lib/network-stack';

const app = new cdk.App();
const networkStack = new NetworkStack(app, 'NetworkStack');
new AirflowOnEcsStack(app, 'AirflowOnEcsStack', {
    vpc: networkStack.vpc,
    repositoryUrl: 'https://github.com/zaltoprofen/airflow-on-ecs',
    syncBranch: 'master',
    dagsDirectory: 'dags',
});
