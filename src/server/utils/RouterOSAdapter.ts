// ! Auto Imports are not supported in this file

import http from 'node:http';
import https from 'node:https';
import debug from 'debug';
import { parseCidr } from 'cidr-tools';
import { stringifyIp } from 'ip-bigint';
import type { ClientType } from '#db/repositories/client/types';
import type { InterfaceType } from '#db/repositories/interface/types';

const ROS_DEBUG = debug('RouterOS');

// ── RouterOS REST API types ──────────────────────────────────────────────────

type RouterOSWgInterface = {
  '.id': string;
  name: string;
  'private-key': string; // always '*****' in GET responses
  'public-key': string;
  'listen-port': string;
  mtu: string;
  running: string;  // "true" / "false" (string, not boolean)
  disabled: string;
};

type RouterOSPeer = {
  '.id': string;
  interface: string;
  'public-key': string;
  'allowed-address': string;
  'preshared-key': string;
  // Configured static endpoint (may be empty for road-warrior clients)
  'endpoint-address': string;
  'endpoint-port': string;
  // Live connection info — only populated when peer is connected
  'current-endpoint-address': string;
  'current-endpoint-port': string;
  // last-handshake only appears after at least one successful handshake
  'last-handshake'?: string;
  'persistent-keepalive'?: string;
  comment?: string;
  rx: string; // bytes as string
  tx: string;
};

type RouterOSAddress = {
  '.id': string;
  address: string;
  interface: string;
};

// ── Public types ─────────────────────────────────────────────────────────────

export type PeerDumpEntry = {
  publicKey: string;
  preSharedKey: string;
  endpoint: string | null;
  allowedIps: string;
  latestHandshakeAt: Date | null;
  transferRx: number;
  transferTx: number;
  persistentKeepalive: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * RouterOS returns last-handshake as a duration string relative to now,
 * e.g. "2m6s", "1h5m3s", "2d3h5m6s". Convert to an absolute Date.
 */
function parseRouterOSDuration(s: string): Date | null {
  const re = /(?:(\d+)w)?(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/;
  const m = s.match(re);
  if (!m || !m[0]) return null;
  const [, weeks, days, hours, minutes, seconds] = m.map((v) =>
    v ? parseInt(v, 10) : 0
  );
  const ms =
    (weeks * 7 * 86400 + days * 86400 + hours * 3600 + minutes * 60 + seconds) *
    1000;
  return ms > 0 ? new Date(Date.now() - ms) : null;
}

function parsePeer(peer: RouterOSPeer): PeerDumpEntry {
  // Use current (live) endpoint, fall back to configured endpoint
  const endpointAddr =
    peer['current-endpoint-address'] || peer['endpoint-address'];
  const endpointPort =
    peer['current-endpoint-port'] || peer['endpoint-port'];
  const endpoint =
    endpointAddr && endpointAddr !== '0.0.0.0' && endpointAddr !== ''
      ? `${endpointAddr}:${endpointPort}`
      : null;

  // last-handshake is a RouterOS duration string ("2m6s", "1h5m3s", …)
  // that represents how long ago the handshake occurred.
  let latestHandshakeAt: Date | null = null;
  const hs = peer['last-handshake'];
  if (hs && hs !== '') {
    latestHandshakeAt = parseRouterOSDuration(hs);
  }

  return {
    publicKey: peer['public-key'],
    preSharedKey: peer['preshared-key'] ?? '',
    endpoint,
    allowedIps: peer['allowed-address'],
    latestHandshakeAt,
    transferRx: parseInt(peer.rx ?? '0', 10),
    transferTx: parseInt(peer.tx ?? '0', 10),
    persistentKeepalive: peer['persistent-keepalive'] ?? 'off',
  };
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class RouterOSAdapter {
  readonly #hostname: string;
  readonly #port: string;
  readonly #headers: Record<string, string>;
  readonly #interfaceName: string;
  readonly #agent: http.Agent | https.Agent;
  readonly #useHttps: boolean;

  /**
   * @param host  Full URL or bare hostname/IP.
   *              Examples: "http://192.168.1.1", "192.168.1.1", "https://router.local"
   *              Defaults to https:// if no protocol is specified.
   */
  constructor(
    host: string,
    user: string,
    password: string,
    interfaceName: string,
    verifySSL: boolean
  ) {
    // Normalise host to a full URL so we can extract protocol/hostname/port
    const url = new URL(
      host.startsWith('http://') || host.startsWith('https://')
        ? host
        : `https://${host}`
    );

    this.#useHttps = url.protocol === 'https:';
    this.#hostname = url.hostname;
    this.#port = url.port || (this.#useHttps ? '443' : '80');
    this.#headers = {
      Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    };
    this.#interfaceName = interfaceName;
    this.#agent = this.#useHttps
      ? new https.Agent({ rejectUnauthorized: verifySSL })
      : new http.Agent();
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  #request(
    path: string,
    options: { method?: string; body?: string } = {}
  ): Promise<unknown> {
    const method = options.method ?? 'GET';
    ROS_DEBUG(
      `${method} ${this.#useHttps ? 'https' : 'http'}://${this.#hostname}/rest${path}`
    );

    return new Promise((resolve, reject) => {
      const body = options.body ? Buffer.from(options.body, 'utf-8') : null;
      const reqOptions = {
        hostname: this.#hostname,
        port: this.#port,
        path: `/rest${path}`,
        method,
        headers: {
          ...this.#headers,
          ...(body ? { 'Content-Length': body.byteLength } : {}),
        },
        agent: this.#agent,
      };

      const transport = this.#useHttps ? https : http;
      const req = transport.request(reqOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            if (status === 204 || responseBody === '') return resolve(null);
            try {
              resolve(JSON.parse(responseBody));
            } catch {
              reject(new Error(`RouterOS invalid JSON: ${responseBody}`));
            }
          } else {
            reject(new Error(`RouterOS API ${status}: ${responseBody}`));
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  // ── Interface sync ────────────────────────────────────────────────────────

  /**
   * Creates or updates the WireGuard interface on RouterOS, including
   * its IPv4 (and optionally IPv6) address binding.
   */
  async syncInterface(
    wgInterface: Pick<
      InterfaceType,
      'name' | 'privateKey' | 'port' | 'mtu' | 'ipv4Cidr' | 'ipv6Cidr'
    >,
    enableIpv6: boolean
  ): Promise<void> {
    await this.#syncWgInterface(wgInterface);
    await this.#syncAddress(wgInterface.ipv4Cidr, 4);
    if (enableIpv6) {
      await this.#syncAddress(wgInterface.ipv6Cidr, 6);
    }
    ROS_DEBUG(`Interface "${this.#interfaceName}" synced to RouterOS.`);
  }

  async #syncWgInterface(
    wgInterface: Pick<InterfaceType, 'privateKey' | 'port' | 'mtu'>
  ): Promise<void> {
    const list = (await this.#request(
      `/interface/wireguard?name=${encodeURIComponent(this.#interfaceName)}`
    )) as RouterOSWgInterface[];

    const existing = Array.isArray(list)
      ? list.find((i) => i.name === this.#interfaceName)
      : null;

    const payload = {
      name: this.#interfaceName,
      'private-key': wgInterface.privateKey,
      'listen-port': String(wgInterface.port),
      mtu: String(wgInterface.mtu),
    };

    if (existing) {
      await this.#request(`/interface/wireguard/${existing['.id']}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      await this.#request('/interface/wireguard', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
    }
  }

  async #syncAddress(cidr: string, version: 4 | 6): Promise<void> {
    const parsed = parseCidr(cidr);
    const hostAddr = stringifyIp({ number: parsed.start + 1n, version });
    const address = `${hostAddr}/${parsed.prefix}`;

    const endpoint = version === 4 ? '/ip/address' : '/ipv6/address';
    // IPv6: disable RA advertisement — WireGuard interfaces should not advertise prefixes
    const extraFields = version === 6 ? { advertise: 'no' } : {};

    const list = (await this.#request(
      `${endpoint}?interface=${encodeURIComponent(this.#interfaceName)}`
    )) as RouterOSAddress[];

    const existing = Array.isArray(list) ? list[0] : null;

    if (existing) {
      if (existing.address !== address) {
        try {
          await this.#request(`${endpoint}/${existing['.id']}`, {
            method: 'PATCH',
            body: JSON.stringify({ address, ...extraFields }),
          });
        } catch (err: any) {
          if (err.message?.includes('can not change dynamic')) {
            // RouterOS marks WireGuard-owned addresses as dynamic; delete and re-add as static
            await this.#request(`${endpoint}/${existing['.id']}`, { method: 'DELETE' });
            await this.#request(endpoint, {
              method: 'PUT',
              body: JSON.stringify({ address, interface: this.#interfaceName, ...extraFields }),
            });
          } else {
            throw err;
          }
        }
      }
    } else {
      await this.#request(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ address, interface: this.#interfaceName, ...extraFields }),
      });
    }
  }

  // ── Peer sync ─────────────────────────────────────────────────────────────

  /**
   * Diffs enabled clients against existing RouterOS peers and
   * creates, updates, or removes peers as needed.
   */
  async syncPeers(
    clients: Pick<
      ClientType,
      | 'publicKey'
      | 'preSharedKey'
      | 'ipv4Address'
      | 'ipv6Address'
      | 'enabled'
      | 'id'
      | 'name'
    >[],
    enableIpv6: boolean
  ): Promise<void> {
    const result = await this.#request(
      `/interface/wireguard/peers?interface=${encodeURIComponent(this.#interfaceName)}`
    );
    const existing: RouterOSPeer[] = Array.isArray(result) ? result : [];
    const existingByKey = new Map(existing.map((p) => [p['public-key'], p]));

    const enabledClients = clients.filter((c) => c.enabled);
    const enabledKeys = new Set(enabledClients.map((c) => c.publicKey));

    for (const client of enabledClients) {
      const allowedAddress = enableIpv6
        ? `${client.ipv4Address}/32,${client.ipv6Address}/128`
        : `${client.ipv4Address}/32`;

      const peer = existingByKey.get(client.publicKey);
      if (peer) {
        await this.#request(`/interface/wireguard/peers/${peer['.id']}`, {
          method: 'PATCH',
          body: JSON.stringify({
            'allowed-address': allowedAddress,
            'preshared-key': client.preSharedKey,
            comment: `${client.name} (${client.id})`,
          }),
        });
      } else {
        await this.#request('/interface/wireguard/peers', {
          method: 'PUT',
          body: JSON.stringify({
            interface: this.#interfaceName,
            'public-key': client.publicKey,
            'allowed-address': allowedAddress,
            'preshared-key': client.preSharedKey,
            comment: `${client.name} (${client.id})`,
          }),
        });
      }
    }

    for (const [key, peer] of existingByKey) {
      if (!enabledKeys.has(key)) {
        await this.#request(`/interface/wireguard/peers/${peer['.id']}`, {
          method: 'DELETE',
        });
      }
    }

    ROS_DEBUG(
      `Synced ${enabledClients.length} peers to RouterOS interface "${this.#interfaceName}".`
    );
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /**
   * Returns live peer stats from RouterOS in the same shape as `wg show dump`.
   */
  async dump(): Promise<PeerDumpEntry[]> {
    const result = await this.#request(
      `/interface/wireguard/peers?interface=${encodeURIComponent(this.#interfaceName)}`
    );
    const peers: RouterOSPeer[] = Array.isArray(result) ? result : [];
    return peers.map(parsePeer);
  }
}
