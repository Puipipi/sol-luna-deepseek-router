import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp, rm} from 'node:fs/promises';
import { createApiProfile } from '../scripts/native-api-settings.mjs';
import { listApiModels } from '../scripts/native-api-models.mjs';
import { createRouterSettingsService } from '../scripts/router-settings-mcp.mjs';

const key = 'local-test-only-secret';
const servers = [];
async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  return server.address().port;
}

const baseProfile = port => createApiProfile({
  protocol: 'chat_completions',
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: 'manual-model',
  reasoning: {supported: ['none'], default: 'none', parameter: 'none'},
  credential: {type: 'env', name: 'LOCAL_TEST_API_KEY'},
});

try {
  let receivedAuthorization = '';
  const listingPort = await listen((request, response) => {
    receivedAuthorization = request.headers.authorization || '';
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({data: [{id: 'model-a'}, {id: 'model-b'}, {name: 'no-id'}]}));
  });
  const models = await listApiModels(baseProfile(listingPort), {env: {LOCAL_TEST_API_KEY: key}});
  assert.deepEqual(models, ['model-a', 'model-b'], 'explicit model discovery returns exact wire model IDs');
  assert.equal(receivedAuthorization, `Bearer ${key}`, 'credential resolver supplies auth only to the selected local endpoint');
  assert.equal(JSON.stringify(models).includes(key), false, 'model-list output never contains the API key');
  const serviceRoot = await mkdtemp(path.join(os.tmpdir(), 'router-api-model-mcp-'));
  try {
    const service = createRouterSettingsService({
      settingsPath: path.join(serviceRoot, 'router.json'),
      env: {LOCAL_TEST_API_KEY: key},
      readNativeModels: async () => [],
    });
    const result = await service.callTool('router_settings_list_api_models', {
      baseUrl: `http://127.0.0.1:${listingPort}/v1`,
      protocol: 'chat_completions',
      credential: {type: 'env', name: 'LOCAL_TEST_API_KEY'},
    });
    assert.deepEqual(result.payload.models, ['model-a', 'model-b'], 'the explicit MCP action uses the configured local profile endpoint');
    assert.equal(JSON.stringify(result).includes(key), false, 'MCP model-list results never reveal credential values');
  } finally {
    await rm(serviceRoot, {recursive: true, force: true});
  }

  let redirectTargetRequests = 0;
  const targetPort = await listen((_request, response) => {
    redirectTargetRequests += 1;
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({data: [{id: 'should-not-leak'}]}));
  });
  const redirectPort = await listen((_request, response) => {
    response.writeHead(302, {location: `http://127.0.0.1:${targetPort}/capture`});
    response.end();
  });
  await assert.rejects(
    listApiModels(baseProfile(redirectPort), {env: {LOCAL_TEST_API_KEY: key}}),
    /redirects are blocked/,
    'model discovery refuses redirects instead of forwarding credentials',
  );
  assert.equal(redirectTargetRequests, 0, 'redirect destination never receives a model-list request');

  const failurePort = await listen((_request, response) => {
    response.writeHead(503);
    response.end('upstream secret response text');
  });
  await assert.rejects(
    listApiModels(baseProfile(failurePort), {env: {LOCAL_TEST_API_KEY: key}}),
    error => error.message.includes('HTTP 503') && !error.message.includes('upstream secret'),
    'model discovery reports only safe status diagnostics',
  );
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}

console.log('PASS API model discovery loopback assertions');
