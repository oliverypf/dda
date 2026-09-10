const old=globalThis.fetch;
globalThis.fetch=async (...args)=>{const [url,opt]=args; const res=await old(...args); if(!res.ok){const clone=res.clone(); console.error('MODEL_STATUS',res.status); console.error('MODEL_BODY',(await clone.text()).slice(0,4000));} else console.error('MODEL_STATUS',res.status); return res;};
await import('./src/index.mjs');