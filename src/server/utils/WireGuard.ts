import debug from 'debug';
import type { InterfaceType } from '#db/repositories/interface/types';
import { RouterOSAdapter } from './RouterOSAdapter';

const WG_DEBUG = debug('WireGuard');

class WireGuard {
  #routerOS!: RouterOSAdapter;

  /**
   * Syncs the full WireGuard config (interface + peers) to RouterOS.
   * Called on startup and after any client or interface change.
   */
  async saveConfig() {
    const wgInterface = await Database.interfaces.get();
    await this.#syncToRouterOS(wgInterface);
  }

  async #syncToRouterOS(wgInterface: InterfaceType) {
    await this.#routerOS.syncInterface(wgInterface, !WG_ENV.DISABLE_IPV6);
    const clients = await Database.clients.getAll();
    await this.#routerOS.syncPeers(clients, !WG_ENV.DISABLE_IPV6);
  }

  async getClientsForUser(userId: ID, filter?: string) {
    let dbClients;
    if (filter?.trim()) {
      dbClients = await Database.clients.getForUserFiltered(userId, filter);
    } else {
      dbClients = await Database.clients.getForUser(userId);
    }

    const clients = dbClients.map((client) => ({
      ...client,
      latestHandshakeAt: null as Date | null,
      endpoint: null as string | null,
      transferRx: null as number | null,
      transferTx: null as number | null,
    }));

    const dump = await this.#routerOS.dump();
    dump.forEach(
      ({ publicKey, latestHandshakeAt, endpoint, transferRx, transferTx }) => {
        const client = clients.find((c) => c.publicKey === publicKey);
        if (!client) return;
        client.latestHandshakeAt = latestHandshakeAt;
        client.endpoint = endpoint;
        client.transferRx = transferRx;
        client.transferTx = transferTx;
      }
    );

    return clients;
  }

  async dumpByPublicKey(publicKey: string) {
    const dump = await this.#routerOS.dump();
    return dump.find(({ publicKey: pk }) => pk === publicKey);
  }

  async getAllClients(filter?: string) {
    let dbClients;
    if (filter?.trim()) {
      dbClients = await Database.clients.getAllPublicFiltered(filter);
    } else {
      dbClients = await Database.clients.getAllPublic();
    }

    const clients = dbClients.map((client) => ({
      ...client,
      latestHandshakeAt: null as Date | null,
      endpoint: null as string | null,
      transferRx: null as number | null,
      transferTx: null as number | null,
    }));

    const dump = await this.#routerOS.dump();
    dump.forEach(
      ({ publicKey, latestHandshakeAt, endpoint, transferRx, transferTx }) => {
        const client = clients.find((c) => c.publicKey === publicKey);
        if (!client) return;
        client.latestHandshakeAt = latestHandshakeAt;
        client.endpoint = endpoint;
        client.transferRx = transferRx;
        client.transferTx = transferTx;
      }
    );

    return clients;
  }

  async getClientConfiguration({ clientId }: { clientId: ID }) {
    const wgInterface = await Database.interfaces.get();
    const userConfig = await Database.userConfigs.get();
    const client = await Database.clients.get(clientId);

    if (!client) {
      throw new Error('Client not found');
    }

    return wg.generateClientConfig(wgInterface, userConfig, client, {
      enableIpv6: !WG_ENV.DISABLE_IPV6,
    });
  }

  async getClientQRCodeSVG({ clientId }: { clientId: ID }) {
    const config = await this.getClientConfiguration({ clientId });
    return encodeQRCode(config);
  }

  cleanClientFilename(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9_=+.-]/g, '-')
      .replace(/(-{2,}|-$)/g, '-')
      .replace(/-$/, '')
      .substring(0, 32);
  }

  async Startup() {
    WG_DEBUG('Starting routewire...');

    if (!ROUTEROS_ENV.HOST) {
      throw new Error(
        'ROUTEROS_HOST is not set. routewire requires a RouterOS backend.'
      );
    }

    this.#routerOS = new RouterOSAdapter(
      ROUTEROS_ENV.HOST,
      ROUTEROS_ENV.USER,
      ROUTEROS_ENV.PASSWORD,
      ROUTEROS_ENV.INTERFACE,
      ROUTEROS_ENV.VERIFY_SSL
    );

    let wgInterface = await Database.interfaces.get();

    // Generate server keypair on first boot and store in DB.
    // The private key will be pushed to RouterOS via syncInterface.
    if (
      wgInterface.privateKey === '---default---' &&
      wgInterface.publicKey === '---default---'
    ) {
      WG_DEBUG('Generating server keypair...');
      const privateKey = await wg.generatePrivateKey();
      const publicKey = await wg.getPublicKey(privateKey);
      await Database.interfaces.updateKeyPair(privateKey, publicKey);
      wgInterface = await Database.interfaces.get();
      WG_DEBUG('Server keypair generated.');
    }

    WG_DEBUG(
      `Syncing to RouterOS ${ROUTEROS_ENV.HOST} interface "${ROUTEROS_ENV.INTERFACE}"...`
    );
    await this.#syncToRouterOS(wgInterface);
    WG_DEBUG('RouterOS sync complete.');

    WG_DEBUG('Starting cron job...');
    await this.startCronJob();
    WG_DEBUG('Cron job started.');
  }

  // TODO: handle as worker_thread
  async startCronJob() {
    setIntervalImmediately(() => {
      this.cronJob().catch((err) => {
        WG_DEBUG('Cron job failed.');
        console.error(err);
      });
    }, 60 * 1000);
  }

  async Shutdown() {
    // RouterOS manages the interface lifecycle; nothing to tear down locally.
  }

  async Restart() {
    // Re-sync on demand instead of bouncing the daemon.
    await this.saveConfig();
  }

  async cronJob() {
    const clients = await Database.clients.getAll();
    let needsSave = false;

    // Expires Feature
    for (const client of clients) {
      if (client.enabled !== true) continue;
      if (
        client.expiresAt !== null &&
        new Date() > new Date(client.expiresAt)
      ) {
        WG_DEBUG(`Client ${client.id} expired.`);
        await Database.clients.toggle(client.id, false);
        needsSave = true;
      }
    }

    // One Time Link Feature
    for (const client of clients) {
      if (
        client.oneTimeLink !== null &&
        new Date() > new Date(client.oneTimeLink.expiresAt)
      ) {
        WG_DEBUG(`OneTimeLink for client ${client.id} expired.`);
        await Database.oneTimeLinks.delete(client.id);
      }
    }

    if (needsSave) {
      await this.saveConfig();
    }
  }
}

if (OLD_ENV.PASSWORD || OLD_ENV.PASSWORD_HASH) {
  throw new Error(
    `
You are using an invalid Configuration for wg-easy
Please follow the instructions on https://wg-easy.github.io/wg-easy/latest/advanced/migrate/from-14-to-15/ to migrate
`
  );
}

export default new WireGuard();
