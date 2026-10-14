import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Kept separate from browser setup so fixture routing is testable offline.
export function createFormsFixtureHandler({ route, siteRoot, renderShop, origin, posts }) {
  const submission = route === 'shop' ? '/shop/checkout/order' : '/submit/' + route;
  const logging = new Set(['/api/log', ...(route === 'shop' ? ['/shop/checkout/api/log'] : [])]);
  return async (request, response) => {
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      // The demo logs input and pointer events (including text/plain JSON).
      // Logging has no submission effect and never contributes an order receipt.
      if (logging.has(request.url)) { response.writeHead(204).end(); return; }
      if (request.url !== submission) { response.writeHead(404).end(); return; }
      const data = request.headers['content-type']?.includes('json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      posts.push({ path: request.url, data });
      if (route === 'shop') response.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Order placed</h1>');
      else response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'P2-FIXTURE' }));
      return;
    }
    if (route === 'shop') { response.writeHead(200, { 'content-type': 'text/html' }).end(renderShop('checkout/payment', { base: '', cart: ['harbor'] }, origin())); return; }
    const names = { '/travel': 'travel.html', '/settings': 'settings.html', '/checkout': 'checkout.html', '/common.js': 'common.js', '/airports.json': 'airports.json', '/style.css': 'style.css' };
    const name = names[new URL(request.url, 'http://fixture.invalid').pathname];
    if (!name) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.json') ? 'application/json' : name.endsWith('.css') ? 'text/css' : 'text/html' })
      .end(readFileSync(join(siteRoot, name), 'utf8'));
  };
}

export async function finishTravelFixture(f) {
  await f.click('#to2');
  await f.fill([['#country', 'Japan'], ['#city', 'Osaka']]);
  await f.click('#airports [role="option"]');
  await f.click('#to3');
  await f.click('#seatmap button:not(:disabled)');
  await f.click('button[type="submit"]');
  return f.posted();
}
