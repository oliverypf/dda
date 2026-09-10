import { Context } from '@deepseek-ai/cordis';
import { createOpenAICompatiblePlugin } from './src/plugins/model-openai.mjs';
const root=new Context(); await root.plugin(createOpenAICompatiblePlugin({protocol:'responses', model:'gpt-5.6-terra',baseURL:'https://api.dengjiuwanle.com/v1',endpoint:'https://api.dengjiuwanle.com/v1/responses',apiKeyEnv:'DENGJIUWANLE_API_KEY'}));
const req={system:'You are a test. Use workspace.list once then answer.',messages:[{role:'user',content:'List files in workspace.'}],tools:[{name:'workspace.list',description:'List files',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
for await (const c of root.modelProvider.stream(req)) console.log(JSON.stringify(c));