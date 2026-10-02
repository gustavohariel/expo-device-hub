---
'@expo/serve-sim': minor
---

Network capture forwards each captured request through the proxy the host's system settings
choose for its URL: manual proxies, the bypass list, a PAC file, or auto-discovery. Capture now
works with EAS local egress and behind HTTP proxies that do not require authentication.
`SERVE_SIM_CAPTURE_UPSTREAM` forces one HTTP proxy, or `none` sends captured traffic direct.
