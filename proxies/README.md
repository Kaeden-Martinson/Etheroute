# Proxy Configuration

Add your proxy list to `proxies.json` in the following format:

```json
[
  {
    "ip": "proxy-hostname-or-ip",
    "port": 8080,
    "username": "your-username",
    "password": "your-password"
  }
]
```

**Requirements:**
- `ip`: Proxy hostname or IP address (string)
- `port`: Proxy port number (integer)
- `username`: Authentication username (string)
- `password`: Authentication password (string)

## Example

```json
[
  {
    "ip": "proxy1.brightdata.com",
    "port": 8080,
    "username": "username-zone-country",
    "password": "your-password"
  },
  {
    "ip": "proxy2.brightdata.com",
    "port": 8080,
    "username": "username-zone-city",
    "password": "your-password"
  }
]
```

## Notes

- Proxies are rotated in a round-robin fashion for load balancing
- If no proxies are configured, requests fall back to direct connections
- Rate-limited requests (429) will retry with a different proxy
