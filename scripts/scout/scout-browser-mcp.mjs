#!/usr/bin/env node
// Stdio MCP adapter: lets the existing Scout Codex agent request a bounded,
// source-cited visual web investigation without altering map-factory data.
import readline from 'node:readline';
import { browserToolStatus, researchWithBrowser } from './browser-tool.mjs';

const serverInfo={name:'rtt-scout-browser',version:'0.1.0'};
const tools=[
  {
    name:'scout_browser_status',
    annotations:{title:'Scout browser readiness',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    description:'Check whether Scout\'s general-purpose Chromium browser research tool is ready on this machine. Read-only.',
    inputSchema:{type:'object',properties:{},additionalProperties:false}
  },
  {
    name:'scout_browser_research',
    annotations:{title:'Scout public-web research',readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    description:'Ask Scout to visually investigate ordinary public internet websites using real Chromium clicks, typing, maps and screenshots, guided by bounded AI decisions. Returns evidence URLs and a research answer. Treat findings as research only, NEVER legal motorcycle access verification or authority to edit RT&T/Pathfinder data. Do not use for logins, purchases, uploads, messages, scraping restricted sites, or private-network access.',
    inputSchema:{
      type:'object',properties:{
        instruction:{type:'string',minLength:5,maxLength:3000,description:'Specific research task. Mention the target website or information to find.'},
        maxSteps:{type:'integer',minimum:1,maximum:12,description:'Maximum browser decisions, default 6.'}
      },required:['instruction'],additionalProperties:false
    }
  }
];
function send(value){process.stdout.write(JSON.stringify(value)+'\n')}
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
for await (const line of rl){
  let request;
  try{request=JSON.parse(line)}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue}
  if(request.id===undefined)continue;
  const id=request.id;
  try{
    if(request.method==='initialize') {
      send({jsonrpc:'2.0',id,result:{
        protocolVersion:request.params?.protocolVersion??'2025-06-18',
        capabilities:{tools:{listChanged:false}},serverInfo
      }});
    }else if(request.method==='ping')send({jsonrpc:'2.0',id,result:{}});
    else if(request.method==='tools/list')send({jsonrpc:'2.0',id,result:{tools}});
    else if(request.method==='tools/call'){
      const name=request.params?.name,args=request.params?.arguments??{};
      if(name==='scout_browser_status')send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(browserToolStatus(),null,2)}]}});
      else if(name==='scout_browser_research'){
        const {instruction,maxSteps=6}=args;
        if(typeof instruction!=='string'||instruction.trim().length<5||instruction.length>3000||!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>12)throw Error('Invalid Scout browser research arguments');
        const result=await researchWithBrowser(instruction,{maxSteps});
        send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result,null,2)}]}});
      }else send({jsonrpc:'2.0',id,error:{code:-32601,message:'Unknown Scout browser tool'}});
    }else send({jsonrpc:'2.0',id,error:{code:-32601,message:'Unknown method'}});
  }catch(error){
    send({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:JSON.stringify({status:'ERROR',error:error instanceof Error?error.message:String(error)})}]}});
  }
}
