const { parser } = require('stream-json/parser.js');

const totals = Object.fromEntries([
  'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'
].map((key) => [key, true]));
const schema = {
  type: true,
  timestamp: true,
  payload: {
    type: true,
    model: true,
    info: { total_token_usage: totals, last_token_usage: totals },
    rate_limits: { account_id: true, user_id: true, secondary: { resets_at: true } }
  }
};

// Keep only usage fields. Message text, images, tool output and unrelated
// arrays are validated by the tokenizer but never assembled in memory.
function createTokenLogProjection() {
  const stream = parser.asStream({ packValues: false });
  const stack = [];
  let root = null;
  let scalar = null;
  let failure = null;

  function target() {
    if (!stack.length) return { schema, assign: (value) => { root = value; } };
    const parent = stack[stack.length - 1];
    const key = parent.key;
    const selected = parent.schema && Object.hasOwn(parent.schema, key) ? parent.schema[key] : null;
    return { schema: selected, assign: (value) => { if (selected) parent.value[key] = value; } };
  }

  function consume({ name, value }) {
    if (name === 'startObject' || name === 'startArray') {
      if (stack.length >= 128) throw new Error('Log nesting exceeds the supported depth');
      const next = target();
      const selected = name === 'startObject' && next.schema && typeof next.schema === 'object';
      const object = selected ? {} : null;
      next.assign(object);
      stack.push({ schema: selected ? next.schema : null, value: object, key: null });
    } else if (name === 'endObject' || name === 'endArray') {
      stack.pop();
    } else if (name === 'startKey') {
      scalar = { kind: 'key', text: '', overflow: false };
    } else if (name === 'startString' || name === 'startNumber') {
      const next = target();
      next.assign(null);
      scalar = { kind: name, text: '', target: next, keep: next.schema === true };
    } else if (name === 'stringChunk' || name === 'numberChunk') {
      if (scalar?.kind === 'key') {
        if (scalar.text.length + value.length > 256) scalar.overflow = true;
        if (!scalar.overflow) scalar.text += value;
      } else if (scalar?.keep) {
        if (scalar.text.length + value.length > 4096) throw new Error('Usage field exceeds the supported length');
        scalar.text += value;
      }
    } else if (name === 'endKey') {
      stack[stack.length - 1].key = scalar.overflow ? null : scalar.text;
      scalar = null;
    } else if (name === 'endString' || name === 'endNumber') {
      if (scalar.keep) scalar.target.assign(name === 'endNumber' ? Number(scalar.text) : scalar.text);
      scalar = null;
    } else if (['trueValue', 'falseValue', 'nullValue'].includes(name)) {
      const next = target();
      next.assign(next.schema === true ? value : null);
    }
  }

  stream.on('error', (error) => { failure = error; });
  stream.on('data', (token) => {
    if (failure) return;
    try { consume(token); } catch (error) { failure = error; stream.destroy(error); }
  });
  return {
    async write(chunk) {
      if (failure) throw failure;
      await new Promise((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve()));
      if (failure) throw failure;
    },
    async finish() {
      if (failure) throw failure;
      await new Promise((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
        stream.end();
      });
      if (failure) throw failure;
      return root;
    },
    destroy: () => stream.destroy()
  };
}

module.exports = { createTokenLogProjection };
