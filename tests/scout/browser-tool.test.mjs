import {test} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {browserToolStatus,parseBrowserOutput,researchWithBrowser} from '../../scripts/scout/browser-tool.mjs';

test('Scout visual-browser capability reports separate executable prerequisites',()=>{
 const result=browserToolStatus({browserHome:'/missing',exists:()=>false});
 assert.equal(result.status,'BLOCKED');
 assert.equal(result.checks.chrome,false);
 assert.equal(result.checks.entry,false);
});

test('Scout browser output has durable evidence schema',()=>{
 const value={id:'test-task',status:'completed',result:'Verified from page',visitedUrls:['https://example.com'],evidence:[{url:'https://example.com',screenshot:'data/cli-evidence/check.png'}]};
 assert.deepEqual(parseBrowserOutput(JSON.stringify(value)),value);
 assert.throws(()=>parseBrowserOutput('{"status":"completed"}'),/invalid research result/);
 assert.throws(()=>parseBrowserOutput('{"id":"x","status":"completed"}'),/missing provenance/);
});

test('Scout browser rejects ambiguous instructions and unbounded step counts',async()=>{
 await assert.rejects(researchWithBrowser('no'),/specific research question/);
 await assert.rejects(researchWithBrowser('Inspect the official map',{maxSteps:100}),/step limit/);
});

test('Scout Codex MCP tool responds to handshake and offers visual browser research',()=>{
 const server=path.resolve('scripts/scout/scout-browser-mcp.mjs');
 const input=[
   {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}},
   {jsonrpc:'2.0',method:'notifications/initialized'},
   {jsonrpc:'2.0',id:2,method:'tools/list'},
   {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'scout_browser_status',arguments:{}}}
 ].map(x=>JSON.stringify(x)).join('\n')+'\n';
 const run=spawnSync(process.execPath,[server],{input,encoding:'utf8',timeout:8000});
 assert.equal(run.status,0,run.stderr);
 const results=run.stdout.trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(results[0].result.serverInfo.name,'rtt-scout-browser');
 assert.ok(results[1].result.tools.find(t=>t.name==='scout_browser_research'));
 assert.equal(results[2].result.content[0].type,'text');
});
