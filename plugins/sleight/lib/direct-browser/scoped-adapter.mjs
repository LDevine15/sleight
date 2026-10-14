import { createHash } from 'node:crypto';
import { immutableJSON } from './ipc.mjs';
import { isFileAuthority, consumeStagedFilePayloads } from './host-files.mjs';
import { isRemoteResources } from './remote-resources.mjs';
import { canonical } from './authority.mjs';
import { popupHook } from './popups.mjs';

const allowed = new Set(['Page.enable', 'DOM.enable', 'Accessibility.enable', 'Runtime.enable']);
const playwrightHash = '852e40f938e72e6129b6c9a8bde3f4cc6cfe5cecb5ac734b6b06c8ad1fde42bf';
const positive = value => Number.isSafeInteger(value) && value > 0;
const states = ['visible', 'hidden', 'enabled', 'disabled', 'editable', 'checked', 'unchecked', 'stable'];
const string = (value, max = 65536) => typeof value === 'string' && Buffer.byteLength(value) <= max;
// Fixed, private byte actuator. Files own their bytes before stage cleanup;
// no browser path read, page callback or arbitrary function crosses this entry.
const fileTransfer = function(payloads) {
  if (!(this instanceof HTMLInputElement) || this.type !== 'file' || this.disabled ||
      !this.multiple && payloads.length !== 1) return { transferred: false, count: 0 };
  const transfer = new DataTransfer();
  for (const payload of payloads) {
    const raw = atob(payload.base64), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    transfer.items.add(new File([bytes], payload.name, { type: payload.mimeType }));
  }
  this.files = transfer.files;
  this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { transferred: true, count: payloads.length };
}.toString();
// Closed HTML drag actuator for one observed list. It calls the page's exposed
// drag/drop operations; it never rewrites DOM order or page model properties.
export const reorderListSource = function(values) {
  const list = this;
  if (!(list instanceof Element) || !['ol', 'ul'].includes(list.localName) ||
      !Array.isArray(values) || !values.length || values.length > 100 || new Set(values).size !== values.length)
    return { effect: 'none' };
  const children = () => Array.from(Object.getOwnPropertyDescriptor(Element.prototype, 'children').get.call(list));
  const label = node => {
    const explicit = Element.prototype.getAttribute.call(node, 'aria-label');
    if (explicit) return explicit.trim();
    let budget = 1000;
    const content = (node, depth = 0) => {
      if (--budget < 0 || depth > 32) throw Error('label budget');
      if (node.nodeType === 3) return Object.getOwnPropertyDescriptor(Node.prototype, 'textContent').get.call(node) || '';
      if (!(node instanceof Element) || Element.prototype.getAttribute.call(node, 'aria-hidden') === 'true' ||
          Element.prototype.getAttribute.call(node, 'hidden') !== null) return '';
      return Array.from(Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes').get.call(node)).map(n => content(n, depth + 1)).join('');
    };
    return content(node).trim();
  };
  const name = label;
  const members = () => {
    const nodes = children(), names = nodes.map(name);
    if (nodes.length !== values.length || new Set(names).size !== names.length ||
        values.some(v => !names.includes(v)) || nodes.some(n => n.localName !== 'li' ||
          Element.prototype.getAttribute.call(n, 'draggable') !== 'true')) return null;
    return nodes;
  };
  const checked = node => {
    if (!list.isConnected || !node.isConnected || !children().includes(node) || node.matches(':disabled') ||
        Element.prototype.getAttribute.call(node, 'aria-disabled') === 'true') return false;
    const rect = Element.prototype.getBoundingClientRect.call(node), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' &&
      node.contains(node.getRootNode().elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  };
  let sent = false;
  try {
    for (let i = 0; i < values.length; i++) {
      const nodes = members();
      if (!nodes) return { effect: sent ? 'unknown' : 'none' };
      if (name(nodes[i]) === values[i]) continue;
      const from = nodes.find(n => name(n) === values[i]), to = nodes[i];
      if (!checked(from) || !checked(to)) return { effect: sent ? 'unknown' : 'none' };
      const transfer = new DataTransfer();
      const emit = (node, type) => {
        if (!checked(from) || !checked(to) || !members()?.includes(from) || !members()?.includes(to)) throw Error('target changed');
        sent = true;
        node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer }));
      };
      emit(from, 'dragstart'); emit(to, 'dragenter'); emit(to, 'dragover'); emit(to, 'drop');
      // A drop may replace every item. Never dispatch a later event to a detached node.
      if (from.isConnected && children().includes(from)) from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
      const after = members();
      if (!after || name(after[i]) !== values[i]) return { effect: 'unknown' };
    }
    const after = members();
    return { effect: after && after.every((n, i) => name(n) === values[i]) ? 'verified' : sent ? 'unknown' : 'none' };
  } catch { return { effect: sent ? 'unknown' : 'none' }; }
}.toString();
const fields = (value, names) => {
  if (!value || Array.isArray(value) || Object.keys(value).some(k => !names.includes(k))) throw Error('SCOPED_COMMAND_DENIED');
};
function template(helper, args) {
  if (!helper || !positive(helper.version) || typeof helper.source !== 'string' || !helper.source ||
      !/^[a-f0-9]{64}$/.test(helper.sha256 ?? '') || createHash('sha256').update(helper.source).digest('hex') !== helper.sha256 ||
      Buffer.byteLength(helper.source) > 65536 && helper.sha256 !== playwrightHash) throw Error('FIXED_HELPER_REQUIRED');
  if (!Array.isArray(args) || args.length > 16) throw Error('FIXED_HELPER_REQUIRED');
  // P2's versioned inspector has a fixed two-argument grammar. Other trusted
  // templates must register data schemas; callbacks cannot validate model code.
  if (helper.kind === 'world-state') {
    if (args.length !== 2 || !['checked', 'selected', 'disabled', 'expanded', 'value'].includes(args[0]) ||
        !['native', 'page'].includes(args[1])) throw Error('FIXED_HELPER_REQUIRED');
  } else {
    const schema = helper.parameters;
    if (!Array.isArray(schema) || schema.length !== args.length || schema.some((rule, i) => {
      if (!rule || Object.keys(rule).some(k => !['type', 'enum', 'maxBytes', 'min', 'max'].includes(k))) return true;
      const value = args[i];
      if (!['string', 'boolean', 'integer'].includes(rule.type) ||
          (rule.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== rule.type)) return true;
      if (rule.enum && (!Array.isArray(rule.enum) || !rule.enum.includes(value))) return true;
      if (rule.type === 'string' && (!positive(rule.maxBytes) || rule.maxBytes > 65536 || Buffer.byteLength(value) > rule.maxBytes)) return true;
      return rule.type === 'integer' && (!Number.isSafeInteger(rule.min) || !Number.isSafeInteger(rule.max) ||
        value < rule.min || value > rule.max);
    })) throw Error('FIXED_HELPER_REQUIRED');
  }
  return helper;
}
// Virtual-target architecture reference: Apache-2.0 FowlBrowser vendor/browserModel.mjs
// and cdpRelay.mjs at 8b689249ba4e33d2626487aad930605c62e2c6a7. This is a new,
// deliberately smaller implementation, not a copied or complete Playwright relay.
// No generic connectOverCDP initializer may use the real root socket.
export function createScopedAdapter({ session, checkLease, helpers, nodeBinding, contextBinding, fileAuthority, fileBinding, dialogBinding, resources }) {
  if (!session || ['send', 'on', 'off'].some(k => typeof session[k] !== 'function') || typeof checkLease !== 'function') throw Error('SCOPED_CONTRACT_REQUIRED');
  if (resources !== undefined && !isRemoteResources(resources)) throw Error('RESOURCE_OWNER_REQUIRED');
  const registry = immutableJSON(helpers), fixed = Object.fromEntries(Object.entries(registry).map(([name, helper]) =>
    [name, name === 'world-state' ? { ...helper, kind: 'world-state' } : helper]));
  const views = new Set(); let connected = true;
  const events = event => {
    for (const view of views) {
      if (!connected || event.sessionId !== view.lease.cdpSessionId) continue;
      view.invalidate(event.method, event.params ?? {});
      if (checkLease(view.lease) !== true) continue;
      for (const fn of view.listeners.get(event.method) ?? []) fn(immutableJSON(event.params ?? {}));
    }
  };
  session.on('event', events);
  return Object.freeze({
    forLease(input) {
      const lease = immutableJSON(input);
      if (['target', 'cdpSessionId', 'frame', 'origin'].some(k => typeof lease[k] !== 'string' || !lease[k]) ||
          !Number.isInteger(lease.document) || !Number.isInteger(lease.epoch) || checkLease(lease) !== true) throw Error('LEASE_LOST');
      const listeners = new Map(), worlds = new Map(), objects = new Map(); let generation = 0, retired = false, dialog, dialogSequence = 0;
      const release = (id, object) => {
        objects.delete(id);
        if (resources && !object.releasing) { object.releasing = true; resources.release(lease, id); }
      };
      const view = { lease, listeners, dispose() {
        retired = true; for (const [id, object] of objects) release(id, object);
        worlds.clear(); listeners.clear();
      }, invalidate(method, params) {
        if (method === 'Page.javascriptDialogOpening') {
          dialog = undefined;
          try {
            if (params.frameId && params.frameId !== lease.frame || new URL(params.url).origin !== lease.origin ||
                !['alert', 'confirm', 'prompt', 'beforeunload'].includes(params.type)) return;
            dialog = { id: 'dialog-' + (++dialogSequence), type: params.type };
          } catch {}
        } else if (method === 'Page.javascriptDialogClosed') dialog = undefined;
        if (method === 'Runtime.executionContextDestroyed') {
          const id = params.executionContextId;
          worlds.delete(id);
          for (const [key, object] of objects) if (object.context === id) release(key, object);
          generation++;
        } else if (['Runtime.executionContextsCleared', 'DOM.documentUpdated'].includes(method) ||
            method === 'Page.frameNavigated' && params.frame?.id === lease.frame ||
            method === 'Page.frameDetached' && params.frameId === lease.frame) {
          generation++; worlds.clear(); for (const [id, object] of objects) release(id, object);
          dialog = undefined; retired = true;
        }
      } }; views.add(view);
      const check = () => { if (!connected || retired || checkLease(lease) !== true) throw Error('LEASE_LOST'); };
      const bound = record => record && Object.keys(lease).filter(key => key !== 'executionContextId').every(key => record[key] === lease[key]);
      const node = id => {
        if (!positive(id) || typeof nodeBinding !== 'function') throw Error('FOREIGN_NODE');
        const record = immutableJSON(nodeBinding(id, lease));
        if (!bound(record) || record.backendNodeId !== id) throw Error('FOREIGN_NODE');
      };
      const context = id => {
        if (!positive(id)) throw Error('WORLD_LOST');
        if (worlds.has(id)) return worlds.get(id);
        if (typeof contextBinding !== 'function') throw Error('WORLD_LOST');
        const record = immutableJSON(contextBinding(id, lease));
        if (!bound(record) || record.executionContextId !== id || record.world !== 'main') throw Error('WORLD_LOST');
        return 'main';
      };
      // The session supplied by the broker is its branded terminal transport.
      // All asynchronous preparation precedes this call, so each physical send
      // passes that same coherent authority fence without a root-session escape.
      const enter = (method, params, window) => { check(); return session.send(method, params, lease.cdpSessionId, window); };
      const reply = async (method, params, acquire = false, window) => {
        const started = generation, result = await enter(method, params, window);
        const id = acquire ? result?.[method === 'DOM.resolveNode' ? 'object' : 'result']?.objectId : undefined;
        if (id && resources) resources.admit(lease, id);
        try { check(); if (started !== generation) throw Error('WORLD_LOST'); }
        catch (error) { if (id && resources) resources.release(lease, id); throw error; }
        return result;
      };
      const api = Object.freeze({ sessionId: lease.cdpSessionId,
        async installBackground() {
          check();
          // Fixed host code only, never an expression from a tool request.
          const source = `(${popupHook})('strict', ${JSON.stringify(lease.clientSession + ':' + lease.turn)})`;
          const script = await reply('Page.addScriptToEvaluateOnNewDocument', { source });
          if (!string(script.identifier, 1024) || !script.identifier) throw Error('BACKGROUND_UNAVAILABLE');
          const result = await reply('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: false });
          if (result.exceptionDetails || result.result?.value !== true) throw Error('BACKGROUND_UNAVAILABLE');
          await reply('Page.setInterceptFileChooserDialog', { enabled: true });
          check(); return true;
        },
        async beginHitTarget(input) {
          check(); const p = immutableJSON(input); fields(p, ['instance', 'node', 'x', 'y']);
          const instance = objects.get(p.instance), object = objects.get(p.node);
          if (instance?.kind !== 'playwright-instance' || object?.node === undefined || instance.context !== object.context ||
              ![p.x, p.y].every(v => Number.isFinite(v) && v >= 0 && v <= 100000)) throw Error('SCOPED_COMMAND_DENIED');
          node(object.node); context(instance.context);
          const result = await reply('Runtime.callFunctionOn', { objectId: p.instance,
            functionDeclaration: 'function(node,x,y){return this.setupHitTargetInterceptor(node,"mouse",{x,y},false);}',
            arguments: [{ objectId: p.node }, { value: p.x }, { value: p.y }], returnByValue: false, awaitPromise: false }, true);
          if (result.exceptionDetails || !string(result.result?.objectId, 1024) || !result.result.objectId) throw Error('COVERED');
          const id = result.result.objectId;
          if (objects.has(id)) throw Error('OBJECT_LOST');
          objects.set(id, { context: instance.context, node: object.node, kind: 'hit-interceptor' });
          return { objectId: id };
        },
        async finishHitTarget(input) {
          check(); const p = immutableJSON(input); fields(p, ['objectId']);
          const object = objects.get(p.objectId);
          if (object?.kind !== 'hit-interceptor') throw Error('OBJECT_LOST');
          node(object.node); context(object.context);
          const result = await reply('Runtime.callFunctionOn', { objectId: p.objectId,
            functionDeclaration: 'function(){return this.stop();}', arguments: [], returnByValue: true, awaitPromise: false });
          if (result.exceptionDetails || result.result?.value !== 'done') throw Error('COVERED');
          return true;
        },
        on(event, fn) { check(); if (typeof fn !== 'function') throw Error('INVALID_ARGUMENT'); if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
        off(event, fn) { listeners.get(event)?.delete(fn); },
        async send(method, input = {}) {
          check(); const params = immutableJSON(input);
          if (method === 'Target.getTargets') return { targetInfos: [{ targetId: lease.target, type: 'page', attached: true }] };
          if (method === 'Target.setAutoAttach') {
            if (Object.keys(params).some(k => !['autoAttach', 'waitForDebuggerOnStart', 'flatten'].includes(k))) throw Error('SCOPED_COMMAND_DENIED');
            // Virtual-only registration. Never forward a browser-wide pause.
            return {};
          }
          if (method === 'Target.attachToTarget') {
            if (params.targetId !== lease.target || Object.keys(params).some(k => !['targetId', 'flatten'].includes(k))) throw Error('FOREIGN_TARGET');
            return { sessionId: lease.cdpSessionId };
          }
          if (method === 'Page.createIsolatedWorld') {
            fields(params, ['frameId', 'worldName', 'grantUniveralAccess']);
            if (params.frameId !== lease.frame) throw Error('FOREIGN_FRAME');
            if (params.worldName !== 'sleight-state' || params.grantUniveralAccess !== undefined && params.grantUniveralAccess !== false)
              throw Error('SCOPED_COMMAND_DENIED');
            const result = await reply(method, { ...params, grantUniveralAccess: false });
            if (!positive(result?.executionContextId)) throw Error('WORLD_LOST');
            worlds.set(result.executionContextId, 'isolated');
            return { executionContextId: result.executionContextId };
          }
          if (method === 'DOM.resolveNode') {
            fields(params, ['backendNodeId', 'executionContextId']); node(params.backendNodeId); context(params.executionContextId);
            const result = await reply(method, params, true);
            try { node(params.backendNodeId); context(params.executionContextId); check(); }
            catch (error) { if (result?.object?.objectId && resources) resources.release(lease, result.object.objectId); throw error; }
            const id = result?.object?.objectId;
            if (typeof id !== 'string' || !id || id.length > 1024 || objects.has(id)) throw Error('OBJECT_LOST');
            objects.set(id, { node: params.backendNodeId, context: params.executionContextId });
            return { object: { objectId: id } };
          }
          if (method === 'Runtime.callFunctionOn') {
            fields(params, ['objectId', 'functionDeclaration', 'arguments', 'returnByValue', 'awaitPromise']);
            const object = objects.get(params.objectId);
            if (!object) throw Error('OBJECT_LOST');
            if (object.node === undefined) throw Error('OBJECT_LOST');
            node(object.node); const world = context(object.context);
            if (params.returnByValue !== true || params.awaitPromise !== undefined && params.awaitPromise !== false) throw Error('SCOPED_COMMAND_DENIED');
            const args = params.arguments ?? [];
            if (!Array.isArray(args) || args.some(arg => !arg || Object.keys(arg).length !== 1 || !Object.hasOwn(arg, 'value')))
              throw Error('FIXED_HELPER_REQUIRED');
            const helper = Object.values(fixed).find(h => h.source === params.functionDeclaration);
            template(helper, args.map(arg => arg.value));
            if (helper.kind === 'world-state' && args[1].value !== (world === 'main' ? 'page' : 'native')) throw Error('FIXED_HELPER_REQUIRED');
            const result = await reply(method, { ...params, arguments: args, awaitPromise: false });
            if (objects.get(params.objectId) !== object) throw Error('OBJECT_LOST');
            node(object.node); context(object.context); check(); return result;
          }
          if (method === 'Runtime.releaseObject') {
            fields(params, ['objectId']);
            if (!objects.has(params.objectId)) throw Error('OBJECT_LOST');
            const result = await reply(method, params);
            if (!result || result.error || result.exceptionDetails) throw Error('OBJECT_RELEASE_UNCONFIRMED');
            resources?.forget(lease, params.objectId); objects.delete(params.objectId); return result;
          }
          if (method === 'DOM.scrollIntoViewIfNeeded') {
            fields(params, ['backendNodeId']); node(params.backendNodeId); return reply(method, params);
          }
          if (method === 'Accessibility.getPartialAXTree') {
            fields(params, ['backendNodeId', 'fetchRelatives', 'maxNodes']); node(params.backendNodeId);
            if (params.fetchRelatives !== false) throw Error('SCOPED_COMMAND_DENIED');
            const maxNodes = params.maxNodes ?? 2048;
            if (!positive(maxNodes) || maxNodes > 2048) throw Error('SCOPED_COMMAND_DENIED');
            const result = await reply(method, { backendNodeId: params.backendNodeId, fetchRelatives: false });
            node(params.backendNodeId); check();
            if (!Array.isArray(result?.nodes) || result.nodes.length > maxNodes || Buffer.byteLength(JSON.stringify(result)) > 262144)
              throw Error('READ_BUDGET');
            for (const entry of result.nodes) {
              if (entry.frameId && entry.frameId !== lease.frame) throw Error('FOREIGN_FRAME');
              if (entry.backendDOMNodeId) node(entry.backendDOMNodeId);
            }
            check();
            return immutableJSON(result);
          }
          if (method === 'DOM.getDocument' || method === 'DOM.describeNode') {
            fields(params, method === 'DOM.getDocument' ? ['depth', 'pierce'] : ['backendNodeId', 'depth', 'pierce']);
            if (!Number.isInteger(params.depth) || params.depth < 0 || params.depth > 2 || params.pierce !== false) throw Error('SCOPED_COMMAND_DENIED');
            if (method === 'DOM.describeNode') node(params.backendNodeId);
            const result = await reply(method, params), root = result?.[method === 'DOM.getDocument' ? 'root' : 'node'];
            let count = 0;
            const prune = (raw, depth = 0) => {
              if (!raw || depth > 3 || ++count > 2048) throw Error('READ_BUDGET');
              node(raw.backendNodeId);
              const { contentDocument, importedDocument, templateContent, distributedNodes, pseudoElements, children, shadowRoots, ...metadata } = raw;
              if (raw.frameId && raw.frameId !== lease.frame && !['iframe', 'frame'].includes(raw.localName)) throw Error('FOREIGN_FRAME');
              return { ...metadata, ...(children && !['iframe', 'frame'].includes(raw.localName) ? { children: children.map(child => prune(child, depth + 1)) } : {}),
                ...(shadowRoots ? { shadowRoots: shadowRoots.map(child => prune(child, depth + 1)) } : {}) };
            };
            if (method === 'DOM.describeNode' && root?.backendNodeId !== params.backendNodeId) throw Error('FOREIGN_NODE');
            if (Buffer.byteLength(JSON.stringify(result)) > 262144) throw Error('READ_BUDGET');
            const value = prune(root); check(); return { [method === 'DOM.getDocument' ? 'root' : 'node']: value };
          }
          if (!allowed.has(method) || Object.keys(params).length) throw Error('SCOPED_COMMAND_DENIED');
          return reply(method, params);
        },
        async installFixed(name, executionContextId) {
          check(); const helper = Object.hasOwn(fixed, name) ? fixed[name] : undefined;
          template(helper, []);
          if (helper.sha256 !== playwrightHash || context(executionContextId) !== 'isolated') throw Error('FIXED_HELPER_REQUIRED');
          // The single oversized exception is a pinned module body, not a CDP
          // function declaration. A fixed wrapper publishes only its constructor
          // handle in the owned isolated world. P2 owns the typed strategies that
          // instantiate it; no arbitrary expression/options cross this boundary.
          const result = await reply('Runtime.callFunctionOn', {
            executionContextId, functionDeclaration: 'function(){const module = {};\n' + helper.source + '\nreturn module.exports.InjectedScript();}',
            arguments: [], returnByValue: false, awaitPromise: false,
          }, true);
          context(executionContextId); check();
          const id = result?.result?.objectId;
          if (typeof id !== 'string' || !id || id.length > 1024 || objects.has(id)) throw Error('OBJECT_LOST');
          objects.set(id, { context: executionContextId, kind: 'playwright-constructor' });
          return { objectId: id };
        },
        async createPlaywright(input) {
          check(); const params = immutableJSON(input); fields(params, ['constructor']);
          const constructor = objects.get(params.constructor);
          if (constructor?.kind !== 'playwright-constructor') throw Error('OBJECT_LOST');
          if (context(constructor.context) !== 'isolated') throw Error('WORLD_LOST');
          // Fixed options match the admitted 1.64.0 constructor. There is no
          // model-controlled custom engine, expression or constructor option.
          const result = await reply('Runtime.callFunctionOn', { objectId: params.constructor,
            functionDeclaration: 'function(){return new this(window,{isUnderTest:false,sdkLanguage:"javascript",testIdAttributeName:"data-testid",stableRafCount:2,browserName:"chromium",customEngines:[]});}',
            arguments: [], returnByValue: false, awaitPromise: false }, true);
          if (objects.get(params.constructor) !== constructor) throw Error('OBJECT_LOST');
          context(constructor.context); check();
          const id = result?.result?.objectId;
          if (!string(id, 1024) || !id || objects.has(id)) throw Error('OBJECT_LOST');
          objects.set(id, { context: constructor.context, kind: 'playwright-instance' });
          return { objectId: id };
        },
        async callPlaywright(input) {
          check(); const p = immutableJSON(input); fields(p, ['instance', 'node', 'method', 'args']);
          const instance = objects.get(p.instance), object = objects.get(p.node);
          if (instance?.kind !== 'playwright-instance' || object?.node === undefined) throw Error('OBJECT_LOST');
          node(object.node);
          if (instance.context !== object.context || context(instance.context) !== 'isolated') throw Error('WORLD_LOST');
          const args = p.args;
          const methods = {
            checkElementStates: ['states'], elementState: ['state'], expectHitTarget: ['x', 'y'],
            ariaSnapshot: ['depth'], fill: ['value'], selectOptions: ['options'], check: ['checked'],
          };
          if (!Object.hasOwn(methods, p.method)) throw Error('SCOPED_COMMAND_DENIED');
          fields(args, methods[p.method]);
          let values, source;
          if (p.method === 'checkElementStates') {
            if (!Array.isArray(args.states) || !args.states.length || args.states.length > states.length ||
                args.states.some(value => !states.includes(value)) || new Set(args.states).size !== args.states.length) throw Error('SCOPED_COMMAND_DENIED');
            source = 'async function(node,states){return await this.checkElementStates(node,states,true) ?? null;}'; values = [args.states];
          } else if (p.method === 'elementState' || p.method === 'check') {
            if (p.method === 'check' ? typeof args.checked !== 'boolean' : !states.filter(v => v !== 'stable').includes(args.state)) throw Error('SCOPED_COMMAND_DENIED');
            source = 'function(node,state){return this.elementState(node,state,true);}';
            values = [p.method === 'check' ? args.checked ? 'checked' : 'unchecked' : args.state];
          } else if (p.method === 'expectHitTarget') {
            if (![args.x, args.y].every(v => Number.isFinite(v) && v >= 0 && v <= 100000)) throw Error('SCOPED_COMMAND_DENIED');
            source = 'function(node,x,y){return this.expectHitTarget({x,y},node);}'; values = [args.x, args.y];
          } else if (p.method === 'ariaSnapshot') {
            if (!positive(args.depth) || args.depth > 10) throw Error('SCOPED_COMMAND_DENIED');
            source = 'function(node,depth){return this.ariaSnapshot(node,{mode:"ai",depth});}'; values = [args.depth];
          } else if (p.method === 'fill') {
            if (!string(args.value)) throw Error('SCOPED_COMMAND_DENIED');
            source = 'function(node,value){return this.fill(node,value);}'; values = [args.value];
          } else {
            if (!Array.isArray(args.options) || !args.options.length || args.options.length > 100) throw Error('SCOPED_COMMAND_DENIED');
            for (const option of args.options) {
              fields(option, ['value', 'label', 'index']);
              if (!Object.keys(option).length || Object.keys(option).some(k => k === 'index' ?
                !Number.isSafeInteger(option[k]) || option[k] < 0 || option[k] > 100000 : !string(option[k], 4096))) throw Error('SCOPED_COMMAND_DENIED');
            }
            source = 'function(node,options){return this.selectOptions(node,options);}'; values = [args.options];
          }
          const result = await reply('Runtime.callFunctionOn', { objectId: p.instance, functionDeclaration: source,
            arguments: [{ objectId: p.node }, ...values.map(value => ({ value }))], returnByValue: true, awaitPromise: true });
          if (objects.get(p.instance) !== instance || objects.get(p.node) !== object) throw Error('OBJECT_LOST');
          node(object.node); context(instance.context); check();
          if (Buffer.byteLength(JSON.stringify(result)) > 262144 || result?.result?.objectId) throw Error('READ_BUDGET');
          return immutableJSON(result);
        },
        async reorderList(input) {
          check(); const p = immutableJSON(input); fields(p, ['node', 'values']);
          const object = objects.get(p.node);
          if (object?.node === undefined || context(object.context) !== 'isolated') throw Error('OBJECT_LOST');
          node(object.node);
          if (!Array.isArray(p.values) || !p.values.length || p.values.length > 100 ||
              new Set(p.values).size !== p.values.length || p.values.some(v => !string(v, 512))) throw Error('SCOPED_COMMAND_DENIED');
          const result = await reply('Runtime.callFunctionOn', { objectId: p.node, functionDeclaration: reorderListSource,
            arguments: [{ value: p.values }], returnByValue: true, awaitPromise: false });
          if (objects.get(p.node) !== object) throw Error('OBJECT_LOST');
          node(object.node); context(object.context); check();
          return result;
        },
        async setFiles(input, capability) {
          check(); const p = immutableJSON(input); fields(p, ['backendNodeId', 'operation']); node(p.backendNodeId);
          if (!isFileAuthority(fileAuthority) || typeof fileBinding !== 'function') throw Error('FILE_AUTHORITY_REQUIRED');
          const binding = immutableJSON(fileBinding(lease, p.backendNodeId));
          if (!binding || binding.target !== lease.target || binding.frame !== lease.frame || binding.document !== lease.document ||
              binding.origin !== lease.origin || binding.leaseGeneration !== lease.epoch || binding.operation !== p.operation ||
              ['clientSession', 'turn', 'browserIncarnation', 'brokerEpoch'].some(k => !Object.hasOwn(lease, k) || binding[k] !== lease[k])) throw Error('FILE_AUTHORITY_REQUIRED');
          const files = fileAuthority.consume(capability, binding);
          node(p.backendNodeId); check();
          return reply('DOM.setFileInputFiles', { backendNodeId: p.backendNodeId, files });
        },
        async setFilePayloads(input, stage) {
          check(); const p = immutableJSON(input); fields(p, ['backendNodeId', 'operation', 'executionContextId']);
          node(p.backendNodeId);
          if (context(p.executionContextId) !== 'isolated') throw Error('WORLD_LOST');
          const binding = () => {
            if (!isFileAuthority(fileAuthority) || typeof fileBinding !== 'function') throw Error('FILE_AUTHORITY_REQUIRED');
            const value = immutableJSON(fileBinding(lease, p.backendNodeId));
            if (!value || value.target !== lease.target || value.frame !== lease.frame || value.document !== lease.document ||
                value.origin !== lease.origin || value.leaseGeneration !== lease.epoch || value.operation !== p.operation ||
                ['clientSession', 'turn', 'browserIncarnation', 'brokerEpoch'].some(k => !Object.hasOwn(lease, k) || value[k] !== lease[k]))
              throw Error('FILE_AUTHORITY_REQUIRED');
            return value;
          };
          const expected = binding();
          // Node acquisition is independently authorized preparation, not the
          // upload. It cannot consume the upload's once grant or transmission.
          const resolved = await api.send('DOM.resolveNode', { backendNodeId: p.backendNodeId, executionContextId: p.executionContextId });
          const objectId = resolved.object.objectId;
          let transfer, cleanup, attempted = false;
          try {
            if (canonical(binding()) !== canonical(expected)) throw Error('FILE_AUTHORITY_REQUIRED');
            const { payloads, window } = consumeStagedFilePayloads(fileAuthority, stage, expected);
            node(p.backendNodeId); context(p.executionContextId); check();
            if (canonical(binding()) !== canonical(expected)) throw Error('FILE_AUTHORITY_REQUIRED');
            attempted = true;
            const result = await reply('Runtime.callFunctionOn', { objectId, functionDeclaration: fileTransfer,
              arguments: [{ value: payloads }], returnByValue: true, awaitPromise: false }, false, window);
            node(p.backendNodeId); context(p.executionContextId); check();
            const value = result?.result?.value;
            transfer = !result.exceptionDetails && value && Object.keys(value).length === 2 &&
              value.transferred === true && value.count === payloads.length ?
              { effect: 'transferred', count: value.count } : { effect: 'unknown', count: 0 };
          } catch (error) {
            if (!attempted) throw error;
            transfer = { effect: 'unknown', count: 0 };
          } finally {
            try { await api.send('Runtime.releaseObject', { objectId }); cleanup = { retained: false }; }
            catch { cleanup = { retained: true, objectId }; }
          }
          return { transfer, cleanup: { stage: stage.receipt(), object: cleanup } };
        },
        async answerDialog(input) {
          check(); const p = immutableJSON(input); fields(p, ['dialogId', 'operation', 'accept', 'promptText']);
          if (!dialog || p.dialogId !== dialog.id || typeof p.accept !== 'boolean' || !string(p.operation, 128) || !p.operation ||
              p.promptText !== undefined && (!string(p.promptText) || dialog.type !== 'prompt' || !p.accept) ||
              typeof dialogBinding !== 'function') throw Error('DIALOG_AUTHORITY_REQUIRED');
          const decision = immutableJSON(dialogBinding(dialog.id, lease));
          if (!bound(decision) || decision.operation !== p.operation || decision.dialogId !== p.dialogId ||
              decision.accept !== p.accept || decision.promptText !== p.promptText) throw Error('DIALOG_AUTHORITY_REQUIRED');
          const current = dialog; dialog = undefined; // No uncertain replay.
          const result = await reply('Page.handleJavaScriptDialog', { accept: p.accept,
            ...(p.promptText === undefined ? {} : { promptText: p.promptText }) });
          if (dialog === current) dialog = undefined;
          return result;
        },
        async callFixed(name, args) {
          check(); const helper = Object.hasOwn(fixed, name) ? fixed[name] : undefined;
          const values = immutableJSON(args); template(helper, values);
          if (helper.kind === 'world-state' || helper.sha256 === playwrightHash) throw Error('FIXED_HELPER_REQUIRED');
          if (!Number.isInteger(lease.executionContextId) || lease.executionContextId < 1) throw Error('FRAME_CONTEXT_REQUIRED');
          // The fixed template is internal trusted code, never model evaluate.
          // Node inspectors use only owned resolved objects through send above.
          context(lease.executionContextId);
          const result = await reply('Runtime.callFunctionOn', { functionDeclaration: helper.source,
            executionContextId: lease.executionContextId, arguments: values.map(value => ({ value })), returnByValue: true, awaitPromise: false });
          context(lease.executionContextId); check(); return result;
        },
        async input(method, input) {
          check(); const params = immutableJSON(input);
          const fields = method === 'Input.dispatchMouseEvent' ? ['type', 'x', 'y', 'button', 'buttons', 'clickCount', 'deltaX', 'deltaY']
            : method === 'Input.insertText' ? ['text'] : method === 'Input.dispatchKeyEvent' ? ['type', 'key', 'code', 'modifiers'] : [];
          if (!fields.length || Object.keys(params).some(k => !fields.includes(k))) throw Error('SCOPED_COMMAND_DENIED');
          if (method === 'Input.dispatchMouseEvent' &&
              (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(params.type) ||
               !Number.isFinite(params.x) || params.x < 0 || !Number.isFinite(params.y) || params.y < 0 ||
               params.button !== undefined && !['none', 'left', 'right', 'middle'].includes(params.button) ||
               params.buttons !== undefined && (!Number.isInteger(params.buttons) || params.buttons < 0 || params.buttons > 7) ||
               params.clickCount !== undefined && (!Number.isInteger(params.clickCount) || params.clickCount < 0 || params.clickCount > 2) ||
               (params.type === 'mouseWheel' ? ![params.deltaX, params.deltaY].every(v => Number.isFinite(v) && Math.abs(v) <= 100000) ||
                 ['button', 'buttons', 'clickCount'].some(k => Object.hasOwn(params, k)) :
                 ['deltaX', 'deltaY'].some(k => Object.hasOwn(params, k)))) ||
              method === 'Input.insertText' && (typeof params.text !== 'string' || Buffer.byteLength(params.text) > 65536) ||
              method === 'Input.dispatchKeyEvent' &&
              (!['keyDown', 'keyUp', 'rawKeyDown', 'char'].includes(params.type) || typeof params.key !== 'string' ||
               typeof params.code !== 'string' || !Number.isInteger(params.modifiers) || params.modifiers < 0 || params.modifiers > 15))
            throw Error('SCOPED_COMMAND_DENIED');
          // Internal actuator entry only; the broker never exposes this view to
          // an IPC client. The trusted fixture driver validates semantics first.
          return reply(method, params);
        },
      });
      return api;
    },
    disconnect() { connected = false; session.off('event', events); for (const view of views) view.dispose(); views.clear(); },
  });
}
