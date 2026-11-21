import { http } from '@kit.NetworkKit';
import { validateModelEndpoint } from './LocalModelTransport';

interface CatalogEntry {
  id: string;
}

interface Catalog {
  data: CatalogEntry[];
}

export async function fetchModelCatalog(baseUrl: string, key: string): Promise<string[]> {
  const endpoint = validateModelEndpoint(baseUrl).replace(/\/(chat\/completions|responses)$/, '/models');
  const client = http.createHttp();
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (key) { headers['Authorization'] = 'Bearer ' + key; }
  try {
    const response = await client.request(endpoint, { method: http.RequestMethod.GET, header: headers,
      maxRedirects: 0, connectTimeout: 10000, readTimeout: 20000, maxLimit: 4 * 1024 * 1024,
      expectDataType: http.HttpDataType.STRING, usingCache: false });
    if (response.responseCode !== 200) { throw new Error('模型目录返回 HTTP ' + response.responseCode); }
    const catalog = JSON.parse(response.result as string) as Catalog;
    if (!catalog || !Array.isArray(catalog.data)) { throw new Error('服务未提供兼容的模型目录，请直接填写模型 ID'); }
    return catalog.data.filter((item: CatalogEntry) => item && typeof item.id === 'string' && item.id.length > 0)
      .map((item: CatalogEntry) => item.id).sort();
  } finally { client.destroy(); }
}
