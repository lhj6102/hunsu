declare module "ws" {
  export class WebSocket {
    constructor(url: string, options?: { headers?: Readonly<Record<string, string>> });
  }
}
