#!/usr/bin/env python3
"""
routewire migration: wg0.json (wg-easy v2/v3 JSON) → wg-easy.db (v15 SQLite)

Dependencies: Python 3.9+ stdlib only (sqlite3, json, ipaddress, argparse)

── Run order ────────────────────────────────────────────────────────────────
1. Start routewire once with INIT_* env vars to create the DB and admin user:

     INIT_ENABLED=true
     INIT_USERNAME=admin
     INIT_PASSWORD=<your password>          # minimum 12 characters
     INIT_HOST=<public IP/hostname>         # e.g. vpn.example.com
     INIT_PORT=<listen port>               # e.g. 51820
     INIT_IPV4_CIDR=10.8.0.0/24
     INIT_IPV6_CIDR=fd42:42:42::/64        # optional
     INIT_DNS=1.1.1.1,1.0.0.1
     INIT_ALLOWED_IPS=0.0.0.0/0,::/0
     # Leave ROUTEROS_HOST unset — avoids pushing a temporary keypair

2. Stop the container.

3. Run this script:
     python3 migrate.py --db /path/to/wg-easy.db --json /path/to/wg0.json

4. Start the container with ROUTEROS_HOST set.
   routewire will push the migrated config to RouterOS on boot.

── What this script does ────────────────────────────────────────────────────
- Restores the server private/public key from wg0.json → interfaces_table
  so existing clients reconnect without reconfiguration
- Restores listen port and MTU
- Imports all clients with their original keypairs and IP assignments
- Optionally derives an IPv6 address per client from --ipv6-cidr
  (maps the last IPv4 octet to the last IPv6 segment)
- Idempotent: safe to re-run; skips clients that already exist by IPv4
─────────────────────────────────────────────────────────────────────────────
"""

import argparse
import ipaddress
import json
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB   = Path("/etc/wireguard/wg-easy.db")
DEFAULT_JSON = Path(__file__).parent / "wg0.json"


def infer_ipv4_cidr(server_address: str) -> str:
    """Derive a /24 network CIDR from the server's IP (e.g. 10.8.0.1 → 10.8.0.0/24)."""
    ip = ipaddress.IPv4Address(server_address)
    network = ipaddress.IPv4Network(f"{ip}/24", strict=False)
    return str(network)


def ipv6_for(ipv4_addr: str, network: ipaddress.IPv6Network) -> str:
    """Map the last IPv4 octet to the last segment of the IPv6 network address."""
    last_octet = int(ipv4_addr.split(".")[-1])
    return str(network.network_address + last_octet)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate wg-easy v2/v3 wg0.json to routewire (wg-easy v15) SQLite DB",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--db", default=str(DEFAULT_DB),
                        help=f"Path to wg-easy.db (default: {DEFAULT_DB})")
    parser.add_argument("--json", default=str(DEFAULT_JSON),
                        help=f"Path to wg0.json (default: {DEFAULT_JSON})")
    parser.add_argument("--interface", default="wg0",
                        help="WireGuard interface name in routewire DB (default: wg0)")
    parser.add_argument("--port", type=int, default=None,
                        help="WireGuard listen port (default: read from wg0.json, else 51820)")
    parser.add_argument("--ipv4-cidr", default=None,
                        help="IPv4 subnet CIDR (default: inferred as /24 from server address)")
    parser.add_argument("--ipv6-cidr", default=None,
                        help="IPv6 subnet CIDR for address derivation (optional)")
    parser.add_argument("--mtu", type=int, default=1420,
                        help="MTU (default: 1420)")
    parser.add_argument("--device", default="eth0",
                        help="Network device name (default: eth0)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be imported without writing to the DB")
    args = parser.parse_args()

    db_path   = Path(args.db)
    json_path = Path(args.json)

    # ── Pre-flight checks ────────────────────────────────────────────────────
    if not json_path.exists():
        print(f"ERROR: wg0.json not found: {json_path}")
        sys.exit(1)

    if not args.dry_run and not db_path.exists():
        print(f"ERROR: Database not found: {db_path}")
        print()
        print("Run routewire once first (with INIT_ENABLED=true) to create the DB,")
        print("then stop the container and run this script.")
        sys.exit(1)

    # ── Load source data ─────────────────────────────────────────────────────
    data    = json.loads(json_path.read_text())
    server  = data["server"]
    clients = list(data["clients"].values())

    listen_port = args.port or data.get("server", {}).get("listenPort") or 51820
    ipv4_cidr   = args.ipv4_cidr or infer_ipv4_cidr(server["address"])
    ipv6_cidr   = args.ipv6_cidr
    ipv6net     = ipaddress.IPv6Network(ipv6_cidr) if ipv6_cidr else None

    print(f"Source:      {json_path}  ({len(clients)} clients)")
    if not args.dry_run:
        print(f"Database:    {db_path}")
    print(f"Interface:   {args.interface}  port={listen_port}  mtu={args.mtu}")
    print(f"IPv4 CIDR:   {ipv4_cidr}")
    print(f"IPv6 CIDR:   {ipv6_cidr or '(disabled)'}")
    if args.dry_run:
        print("Mode:        DRY RUN — no changes will be written")
    print()

    if args.dry_run:
        print(f"  Server keypair: {server['publicKey']}")
        print()
        for c in clients:
            ipv6 = ipv6_for(c["address"], ipv6net) if ipv6net else "-"
            status = "enabled " if c["enabled"] else "disabled"
            print(f"  {'IMPORT':<8s} {c['name']:<32s}  {c['address']:<15s}  {ipv6}  [{status}]")
        print()
        print(f"Would import {len(clients)} clients (dry run — nothing written).")
        return

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    # ── 1. Verify admin user exists ──────────────────────────────────────────
    user = conn.execute("SELECT id, username FROM users_table LIMIT 1").fetchone()
    if not user:
        print("ERROR: No users found in DB.")
        print("Start routewire once with INIT_ENABLED=true to create the admin user.")
        conn.close()
        sys.exit(1)

    user_id = user["id"]
    print(f"Admin user:  id={user_id}  username={user['username']}")

    # ── 2. Restore server keypair and interface config ───────────────────────
    rows_updated = conn.execute("""
        UPDATE interfaces_table SET
            private_key = ?,
            public_key  = ?,
            port        = ?,
            ipv4_cidr   = ?,
            ipv6_cidr   = ?,
            mtu         = ?,
            device      = ?
        WHERE name = ?
    """, (
        server["privateKey"],
        server["publicKey"],
        listen_port,
        ipv4_cidr,
        ipv6_cidr or "",
        args.mtu,
        args.device,
        args.interface,
    )).rowcount

    if rows_updated == 0:
        print(f"ERROR: Interface '{args.interface}' not found in DB.")
        print("Check that INIT vars matched the interface name, or pass --interface.")
        conn.close()
        sys.exit(1)

    print(f"Interface:   keypair and config restored from wg0.json")

    # ── 3. Update user config port and MTU ───────────────────────────────────
    conn.execute("""
        UPDATE user_configs_table SET
            port        = ?,
            default_mtu = ?
        WHERE id = ?
    """, (listen_port, args.mtu, args.interface))
    print(f"User config: port={listen_port}  mtu={args.mtu}")
    print()

    # ── 4. Import clients ────────────────────────────────────────────────────
    imported = 0
    skipped  = 0

    for c in clients:
        ipv4 = c["address"]
        ipv6 = ipv6_for(ipv4, ipv6net) if ipv6net else ""

        existing = conn.execute(
            "SELECT id FROM clients_table WHERE ipv4_address = ?", (ipv4,)
        ).fetchone()

        if existing:
            print(f"  SKIP     {c['name']:<32s}  {ipv4}")
            skipped += 1
            continue

        conn.execute("""
            INSERT INTO clients_table (
                user_id, interface_id,
                name, ipv4_address, ipv6_address,
                private_key, public_key, pre_shared_key,
                server_allowed_ips, persistent_keepalive, mtu,
                enabled, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, ?, ?, ?, ?)
        """, (
            user_id, args.interface,
            c["name"], ipv4, ipv6,
            c["privateKey"], c["publicKey"], c["preSharedKey"],
            args.mtu,
            1 if c["enabled"] else 0,
            c["createdAt"],
            c["updatedAt"],
        ))

        status = "enabled " if c["enabled"] else "disabled"
        ipv6_display = f"  {ipv6}" if ipv6 else ""
        print(f"  IMPORT   {c['name']:<32s}  {ipv4:<15s}{ipv6_display}  [{status}]")
        imported += 1

    conn.commit()
    conn.close()

    print()
    print(f"Done — imported {imported} clients, skipped {skipped}.")
    print()
    print("Next steps:")
    print("  1. Start the container with ROUTEROS_HOST set")
    print("  2. routewire will push the migrated config to RouterOS on boot")
    print("  3. Verify peers: /interface/wireguard/peers print")


if __name__ == "__main__":
    main()
