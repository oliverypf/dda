const originalFetch=globalThis.fetch;
globalThis.fetch=async (...args)=>{const [url,opt]=args; console.error('FETCH',url); console.error('BODY',opt?.body); const result=await originalFetch(...args); return result;};
await import('./src/index.mjs');