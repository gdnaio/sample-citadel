import * as net from 'net';
import {
  ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod,
  RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult,
} from '../../adapters/base';
import { ProvisioningError, ConnectionError } from './errors';

export class ExternalDatabaseAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec;

  constructor(private kind: string) {
    this.spec = { type: `EXTERNAL_${kind.toUpperCase()}`, provider: 'External', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: [], optional: [], ssmParameters: [] } };
  }

  requiredPolicies(
    _config: Record<string, any>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    return { provision: [], connect: [] };
  }

  async provision(
    _config: Record<string, any>,
    _credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    throw new ProvisioningError(
      `Provisioning is not supported for external ${this.kind} data stores`
    );
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const result = await this.testConnection(config, credentials);
    if (!result.success) {
      throw new ConnectionError(
        `Failed to connect to ${this.kind}: ${result.message}`
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op for external stores
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    switch (this.kind) {
      case 'mongodb':
        return this.testMongoConnection(config);
      case 'api':
        return this.testApiConnection(config, credentials);
      case 'postgresql':
      case 'mysql':
      case 'elasticsearch':
      case 'redis':
        return this.testTcpConnection(config);
      default:
        return { success: false, message: `Unsupported external kind: ${this.kind}` };
    }
  }

  async getMetrics(
    _config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    return { size: '0 MB', records: 0 };
  }

  private async testMongoConnection(
    config: Record<string, any>
  ): Promise<ConnectionTestResult> {
    try {
      const url = new URL(config.connectionString);
      const host = url.hostname;
      const port = url.port ? parseInt(url.port, 10) : 27017;
      const reachable = await this.tcpCheck(host, port, 5000);
      if (reachable) {
        return {
          success: true,
          message: `Successfully connected to MongoDB at ${host}:${port}`,
          details: { host, port },
        };
      }
      return {
        success: false,
        message: `Failed to reach MongoDB at ${host}:${port}`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Invalid MongoDB connection string: ${error.message}`,
      };
    }
  }

  /**
   * External REST API connectivity.
   *
   * Backward-compatible: with no `healthPath` configured, this validates that
   * `baseUrl` is well-formed (the original behavior). When a `healthPath` (or
   * `testEndpoint`) is configured, it performs a real authenticated GET and
   * treats a non-2xx response or network error as a failed connection — so an
   * integration is verified end-to-end, not just syntactically.
   *
   * Auth (from `credentials`, method hinted by `config.authMethod`):
   *   - bearer token  -> `Authorization: Bearer <token>`   (token|bearerToken|apiToken)
   *   - api key       -> `<config.apiKeyHeader|X-Api-Key>: <apiKey>`
   *   - basic         -> `Authorization: Basic base64(username:password)`
   */
  private async testApiConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    let baseUrl: URL;
    try {
      baseUrl = new URL(config.baseUrl);
    } catch {
      return { success: false, message: `Invalid API URL: ${config.baseUrl}` };
    }

    const healthPath: string | undefined = config.healthPath ?? config.testEndpoint;
    if (!healthPath) {
      return {
        success: true,
        message: `API URL is well-formed: ${config.baseUrl}`,
        details: { baseUrl: config.baseUrl },
      };
    }

    const target = new URL(healthPath, baseUrl).toString();
    const timeoutMs = typeof config.timeoutMs === 'number' ? config.timeoutMs : 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(target, {
        method: 'GET',
        headers: this.buildAuthHeaders(config, credentials),
        signal: controller.signal,
      });
      if (res.ok) {
        return {
          success: true,
          message: `API reachable: ${target} (${res.status})`,
          details: { baseUrl: config.baseUrl, status: res.status },
        };
      }
      return {
        success: false,
        message: `API returned ${res.status} ${res.statusText} for ${target}`,
        details: { status: res.status },
      };
    } catch (err: any) {
      const reason = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message ?? 'unknown error';
      return { success: false, message: `Failed to reach API at ${target}: ${reason}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private buildAuthHeaders(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const method = String(config.authMethod ?? '').toUpperCase();
    const token = credentials?.token ?? credentials?.bearerToken ?? credentials?.apiToken;
    const apiKey = credentials?.apiKey;
    if (apiKey && method === 'API_KEY') {
      headers[config.apiKeyHeader ?? 'X-Api-Key'] = apiKey;
    } else if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    } else if (credentials?.username && credentials?.password) {
      const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }
    return headers;
  }

  private async testTcpConnection(
    config: Record<string, any>
  ): Promise<ConnectionTestResult> {
    const host = config.host;
    const port = config.port;
    if (!host || !port) {
      return {
        success: false,
        message: `Missing host or port for ${this.kind} connection`,
      };
    }
    const reachable = await this.tcpCheck(host, port, 5000);
    if (reachable) {
      return {
        success: true,
        message: `Successfully connected to ${this.kind} at ${host}:${port}`,
        details: { host, port },
      };
    }
    return {
      success: false,
      message: `Failed to reach ${this.kind} at ${host}:${port}`,
    };
  }

  private tcpCheck(host: string, port: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  }
}
