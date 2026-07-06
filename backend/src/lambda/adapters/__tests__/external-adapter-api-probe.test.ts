import { ExternalDatabaseAdapter } from '../external-adapter';

/**
 * Tests for the authenticated health-probe path added to the External `api`
 * kind. The existing property tests (external-adapter.property.test.ts) cover
 * the no-healthPath fallback; these cover the real-request path with a mocked
 * global fetch.
 */
describe('ExternalDatabaseAdapter (api) authenticated health probe', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function mockFetch(status: number): jest.Mock {
    const fn = jest.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('no healthPath → validates URL only (backward compatible), no fetch', async () => {
    const fetchMock = mockFetch(200);
    const adapter = new ExternalDatabaseAdapter('api');
    const result = await adapter.testConnection({ baseUrl: 'https://api.example.com' });
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('healthPath + 200 → success and sends a bearer Authorization header', async () => {
    const fetchMock = mockFetch(200);
    const adapter = new ExternalDatabaseAdapter('api');
    const result = await adapter.testConnection(
      { baseUrl: 'https://api.example.com', healthPath: '/health', authMethod: 'BEARER_TOKEN' },
      { token: 'secret-token' },
    );
    expect(result.success).toBe(true);
    const [, opts] = fetchMock.mock.calls[0];
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-token');
  });

  it('healthPath + non-2xx → failure with status detail', async () => {
    mockFetch(403);
    const adapter = new ExternalDatabaseAdapter('api');
    const result = await adapter.testConnection(
      { baseUrl: 'https://api.example.com', healthPath: '/health' },
      { token: 't' },
    );
    expect(result.success).toBe(false);
    expect(result.details?.status).toBe(403);
  });

  it('api-key auth → sends the configured api-key header', async () => {
    const fetchMock = mockFetch(200);
    const adapter = new ExternalDatabaseAdapter('api');
    await adapter.testConnection(
      { baseUrl: 'https://api.example.com', healthPath: '/health', authMethod: 'API_KEY', apiKeyHeader: 'X-Api-Key' },
      { apiKey: 'abc123' },
    );
    const [, opts] = fetchMock.mock.calls[0];
    expect((opts.headers as Record<string, string>)['X-Api-Key']).toBe('abc123');
  });
});
