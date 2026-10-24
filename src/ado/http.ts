/* ------------------------------------------------------------------ *
 * One Azure DevOps HTTP request and its response, as plain data so it
 * crosses the daemon socket unchanged. Everything above this layer goes
 * through AdoClient; only the transport and the daemon see these.
 * ------------------------------------------------------------------ */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface AdoRequest {
  method: HttpMethod;
  /** Absolute https URL on dev.azure.com or *.visualstudio.com. */
  url: string;
  body?: string;
  contentType?: string;
  /** What to ask for back; JSON unless this is `text`. */
  accept?: 'json' | 'text';
}

export interface AdoResponse {
  status: number;
  contentType: string | null;
  body: string;
}

/** Sends a request; whoever implements it holds the credentials. */
export type AdoHttp = (req: AdoRequest) => Promise<AdoResponse>;
