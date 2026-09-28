import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A local HTTP server standing in for USGS, scriptable per test. */
export class FakeUpstream {
  private server: Server;
  private handler: Handler = (_req, res) => res.end();
  readonly requestedPaths: string[] = [];
  baseUrl = '';

  constructor() {
    this.server = createServer((req, res) => {
      this.requestedPaths.push(req.url ?? '');
      this.handler(req, res);
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  respond(status: number, body: string, headers: Record<string, string> = {}) {
    this.handler = (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    };
  }

  respondJson(payload: unknown) {
    this.respond(200, JSON.stringify(payload));
  }

  /** Accept the connection but never answer. */
  hang() {
    this.handler = () => undefined;
  }

  /** Send headers and part of the body, then go silent. */
  stallMidBody() {
    this.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"type":"FeatureCollection","features":[');
    };
  }
}
