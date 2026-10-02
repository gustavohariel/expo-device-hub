// Sends HTTP/2 requests to one host over one tunnel through the capture proxy, half of them with
// an explicit :443 authority, at the same time. Prints each stream's path and status as JSON.
// Usage: node h2-mixed-authority.mjs <proxy host:port> <target host> <requests per form>
import http from "node:http";
import http2 from "node:http2";
import tls from "node:tls";

const [proxy, host, perForm] = process.argv.slice(2);
const [proxyHost, proxyPort] = proxy.split(":");

const socket = await new Promise((resolve, reject) => {
  const tunnel = http.request({ host: proxyHost, port: Number(proxyPort), method: "CONNECT", path: `${host}:443` });
  tunnel.once("connect", (_response, connected) => resolve(connected));
  tunnel.once("error", reject);
  tunnel.end();
});
const secure = tls.connect({ socket, servername: host, ALPNProtocols: ["h2"], rejectUnauthorized: false });
await new Promise((resolve, reject) => {
  secure.once("secureConnect", resolve);
  secure.once("error", reject);
});
const session = http2.connect(`https://${host}`, { createConnection: () => secure });

const ask = (authority, path) =>
  new Promise((resolve) => {
    const stream = session.request({ ":method": "GET", ":scheme": "https", ":authority": authority, ":path": path });
    let status = 0;
    stream.on("response", (headers) => (status = headers[":status"]));
    stream.on("error", () => {});
    stream.on("close", () => resolve({ path, status }));
    stream.resume();
    stream.end();
  });

const streams = [];
for (let i = 0; i < Number(perForm); i++) {
  streams.push(ask(`${host}:443`, `/written-${i}`), ask(host, `/implicit-${i}`));
}
console.log(JSON.stringify(await Promise.all(streams)));
session.close();
secure.destroy();
