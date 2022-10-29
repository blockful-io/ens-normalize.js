function decode_arithmetic(bytes) {
	let pos = 0;
	function u16() { return (bytes[pos++] << 8) | bytes[pos++]; }
	
	// decode the frequency table
	let symbol_count = u16();
	let total = 1;
	let acc = [0, 1]; // first symbol has frequency 1
	for (let i = 1; i < symbol_count; i++) {
		acc.push(total += u16());
	}

	// skip the sized-payload that the last 3 symbols index into
	let skip = u16();
	let pos_payload = pos;
	pos += skip;

	let read_width = 0;
	let read_buffer = 0; 
	function read_bit() {
		if (read_width == 0) {
			// this will read beyond end of buffer
			// but (undefined|0) => zero pad
			read_buffer = (read_buffer << 8) | bytes[pos++];
			read_width = 8;
		}
		return (read_buffer >> --read_width) & 1;
	}

	const N = 31;
	const FULL = 2**N;
	const HALF = FULL >>> 1;
	const QRTR = HALF >> 1;
	const MASK = FULL - 1;

	// fill register
	let register = 0;
	for (let i = 0; i < N; i++) register = (register << 1) | read_bit();

	let symbols = [];
	let low = 0;
	let range = FULL; // treat like a float
	while (true) {
		let value = Math.floor((((register - low + 1) * total) - 1) / range);
		let start = 0;
		let end = symbol_count;
		while (end - start > 1) { // binary search
			let mid = (start + end) >>> 1;
			if (value < acc[mid]) {
				end = mid;
			} else {
				start = mid;
			}
		}
		if (start == 0) break; // first symbol is end mark
		symbols.push(start);
		let a = low + Math.floor(range * acc[start]   / total);
		let b = low + Math.floor(range * acc[start+1] / total) - 1;
		while (((a ^ b) & HALF) == 0) {
			register = (register << 1) & MASK | read_bit();
			a = (a << 1) & MASK;
			b = (b << 1) & MASK | 1;
		}
		while (a & ~b & QRTR) {
			register = (register & HALF) | ((register << 1) & (MASK >>> 1)) | read_bit();
			a = (a << 1) ^ HALF;
			b = ((b ^ HALF) << 1) | HALF | 1;
		}
		low = a;
		range = 1 + b - a;
	}
	let offset = symbol_count - 4;
	return symbols.map(x => { // index into payload
		switch (x - offset) {
			case 3: return offset + 0x10100 + ((bytes[pos_payload++] << 16) | (bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 2: return offset + 0x100 + ((bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 1: return offset + bytes[pos_payload++];
			default: return x - 1;
		}
	});
}	

// returns an iterator which returns the next symbol
function read_payload(v) {
	let pos = 0;
	return () => v[pos++];
}
function read_compressed_payload(s) {	
	return read_payload(decode_arithmetic(unsafe_atob(s)));
}

// unsafe in the sense:
// expected well-formed Base64 w/o padding 
function unsafe_atob(s) {
	let lookup = [];
	[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].forEach((c, i) => lookup[c.charCodeAt(0)] = i);
	let n = s.length;
	let ret = new Uint8Array((6 * n) >> 3);
	for (let i = 0, pos = 0, width = 0, carry = 0; i < n; i++) {
		carry = (carry << 6) | lookup[s.charCodeAt(i)];
		width += 6;
		if (width >= 8) {
			ret[pos++] = (carry >> (width -= 8));
		}
	}
	return ret;
}

// eg. [0,1,2,3...] => [0,-1,1,-2,...]
function signed(i) { 
	return (i & 1) ? (~i >> 1) : (i >> 1);
}

function read_counts(n, next) {
	let v = Array(n);
	for (let i = 0; i < n; i++) v[i] = 1 + next();
	return v;
}

function read_ascending(n, next) {
	let v = Array(n);
	for (let i = 0, x = -1; i < n; i++) v[i] = x += 1 + next();
	return v;
}

function read_deltas(n, next) {
	let v = Array(n);
	for (let i = 0, x = 0; i < n; i++) v[i] = x += signed(next());
	return v;
}

// return unsorted? unique array 
function read_member_array(next, lookup) {
	let v = read_ascending(next(), next);
	let n = next();
	let vX = read_ascending(n, next);
	let vN = read_counts(n, next);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < vN[i]; j++) {
			v.push(vX[i] + j);
		}
	}
	return lookup ? v.map(x => lookup[x]) : v;
}

// returns map of x => ys
function read_mapped(next) {
	let ret = [];
	while (true) {
		let w = next();
		if (w == 0) break;
		ret.push(read_linear_table(w, next));
	}
	while (true) {
		let w = next() - 1;
		if (w < 0) break;
		ret.push(read_replacement_table(w, next));
	}
	return ret.flat();
}

// read until next is falsy
// return array of read values
function read_array_while(next) {
	let v = [];
	while (true) {
		let x = next();
		if (!x) break;
		v.push(x);
	}
	return v;
}

// read w columns of length n
// return as n rows of length w
function read_transposed(n, w, next) {
	let m = Array(n).fill().map(() => []);
	for (let i = 0; i < w; i++) {
		read_deltas(n, next).forEach((x, j) => m[j].push(x));
	}
	return m;
}
 
// returns [[x, ys], [x+dx, ys+dy], [x+2*dx, ys+2*dy], ...]
// where dx/dy = steps, n = run size, w = length of y
function read_linear_table(w, next) {
	let dx = 1 + next();
	let dy = next();
	let vN = read_array_while(next);
	let m = read_transposed(vN.length, 1+w, next);
	return m.flatMap((v, i) => {
		let [x, ...ys] = v;
		return Array(vN[i]).fill().map((_, j) => {
			let j_dy = j * dy;
			return [x + j * dx, ys.map(y => y + j_dy)];
		});
	});
}

// return [[x, ys...], ...]
// where w = length of y
function read_replacement_table(w, next) { 
	let n = 1 + next();
	let m = read_transposed(n, 1+w, next);
	return m.map(v => [v[0], v.slice(1)]);
}

function read_emoji_trie(next) {
	let sorted = read_member_array(next).sort((a, b) => a - b);
	return read();
	function read() {
		let branches = [];
		while (true) {
			let keys = read_member_array(next, sorted);
			if (keys.length == 0) break;
			branches.push({set: new Set(keys), node: read()});
		}
		branches.sort((a, b) => b.set.size - a.set.size); // sort by likelihood
		let temp = next();
		let valid = temp % 3;
		temp = (temp / 3)|0;
		let fe0f = !!(temp & 1);
		temp >>= 1;
		let save = temp == 1;
		let check = temp == 2;
		return {branches, valid, fe0f, save, check};
	}
}

// read a list of non-empty lists
// where 0 is terminal
// [1 0 1 2 0 0] => [[1],[1,2]]
function read_sequences(next) {
	return read_array_while(() => {
		let v = read_array_while(next);
		if (v.length) return v.map(x => x - 1);
	});
}

// created 2022-10-29T07:35:17.262Z
var r = read_compressed_payload('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');
const ORDERED_SCRIPTS = [{"name":"Korean","test":[1],"rest":[0,2],"allow":[97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122],"deny":[]},{"name":"Japanese","test":[3,4],"rest":[0,2],"allow":[97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122],"deny":[19968]},{"name":"Han","test":[2],"rest":[0],"allow":[97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116,117,118,119,120,121,122],"deny":[]},{"name":"Latin","test":[5],"rest":[0],"allow":[],"deny":[]},{"name":"Cyrillic","test":[6],"rest":[0],"allow":[],"deny":[]},{"name":"Greek","test":[7],"rest":[0],"allow":[],"deny":[]},{"name":"Arabic","test":[8],"rest":[],"allow":[45],"deny":[]},{"name":"Devanagari","test":[9],"rest":[],"allow":[],"deny":[]},{"name":"Hebrew","test":[10],"rest":[],"allow":[8362],"deny":[]},{"name":"Thai","test":[11],"rest":[],"allow":[3647],"deny":[]}];

function hex_cp(cp) {
	return cp.toString(16).toUpperCase().padStart(2, '0');
}

function quote_cp(cp) {
	return `{${hex_cp(cp)}}`; // raffy convention: like "\u{X}" w/o the "\u"
}

/*
export function explode_cp(s) {
	return [...s].map(c => c.codePointAt(0));
}
*/
function explode_cp(s) { // this is about 2x faster
	let cps = [];
	for (let pos = 0, len = s.length; pos < len; ) {
		let cp = s.codePointAt(pos);
		pos += cp < 0x10000 ? 1 : 2;
		cps.push(cp);
	}
	return cps;
}

function str_from_cps(cps) {
	const chunk = 4096;
	let len = cps.length;
	if (len < chunk) return String.fromCodePoint(...cps);
	let buf = [];
	for (let i = 0; i < len; ) {
		buf.push(String.fromCodePoint(...cps.slice(i, i += chunk)));
	}
	return buf.join('');
}

function compare_arrays(a, b) {
	let {length: n} = a;
	let c = n - b.length;
	for (let i = 0; c == 0 && i < n; i++) c = a[i] - b[i];
	return c;
}

// reverse polyfill

function nf(cps, form) {
	return explode_cp(str_from_cps(cps).normalize(form));
}

function nfc(cps) {
	return nf(cps, 'NFC');
}
function nfd(cps) {
	return nf(cps, 'NFD');
}

const SORTED_VALID = read_member_array(r).sort((a, b) => a - b);
function read_set(lookup) {
	return new Set(read_member_array(r, lookup));
}
function read_valid_subset() {
	return read_set(SORTED_VALID);
}
function read_valid_subsets() {
	return read_array_while(() => { 
		let v = read_valid_subset();
		if (v.size) return v;
	});
}
const VALID = new Set(SORTED_VALID);
const IGNORED = read_set();
const MAPPED = new Map(read_mapped(r));
const CM = read_valid_subset();
const CM_ISOLATED_PH = [];
const CM_WHITELIST = new Map([
	read_array_while(() => {
		let cp = r();
		if (cp) return [cp, read_sequences(r)];
	}),
	read_member_array(r, SORTED_VALID).map(cp => [cp, CM_ISOLATED_PH]),
].flat());
const SCRIPTS = read_valid_subsets(); // [0] is ALL
const ORDERED = ORDERED_SCRIPTS.map(({name, test, rest}) => {
	test = test.map(i => SCRIPTS[i]);
	rest = [test, rest.map(i => SCRIPTS[i])].flat();
	return {name, test, rest, allow: read_valid_subset(), deny: read_valid_subset(), wholes: read_valid_subset()};
});
const RESTRICTED_WHOLES = read_valid_subset();
const RESTRICTED = read_valid_subsets();
const EMOJI_SOLO = read_set();
const EMOJI_ROOT = read_emoji_trie(r);
const NFC_CHECK = read_valid_subset();
const ESCAPE = read_set();
const CM_INVALID = read_set();

const STOP = 0x2E;
const HYPHEN = 0x2D;
const UNDERSCORE = 0x5F;
const FE0F = 0xFE0F;

const COMMON = 'Common';
const STOP_CH = str_from_cps([STOP]);

function check_leading_underscore(cps) {
	let e = cps.lastIndexOf(UNDERSCORE);
	for (let i = e; i > 0; ) {
		if (cps[--i] !== UNDERSCORE) {
			throw new Error(`underscore allowed only at start`);
		}
	}
	return e + 1;
}

// create a safe to print string 
// invisibles are escaped
// leading cm use placeholder
function safe_str_from_cps(cps, quoter = quote_cp) {
	let buf = [];
	if (is_printable_mark(cps[0])) buf.push('◌');
	let prev = 0;
	let n = cps.length;
	for (let i = 0; i < n; i++) {
		let cp = cps[i];
		if (should_escape(cp)) {
			buf.push(str_from_cps(cps.slice(prev, i)));
			buf.push(quoter(cp));
			prev = i + 1;
		}
	}
	buf.push(str_from_cps(cps.slice(prev, n)));
	return buf.join('');
}

function check_label_extension(cps) {
	if (cps.length >= 4 && cps[2] === HYPHEN && cps[3] === HYPHEN && cps.every(cp => cp < 0x80)) {
		throw new Error(`invalid label extension`);
	}
}

// check that cp is not touching another cp
// optionally disallow leading/trailing
function check_surrounding(cps, cp, name, no_leading, no_trailing) {
	let last = -1;
	if (cps[0] === cp) {
		if (no_leading) throw new Error(`leading ${name}`);
		last = 0;
	}
	while (true) {
		let i = cps.indexOf(cp, last+1);
		if (i == -1) break;
		if (last == i-1) throw new Error(`adjacent ${name}`);
		last = i;
	}
	if (no_trailing && last == cps.length-1) throw new Error(`trailing ${name}`);
}

/*
// ContextO: MIDDLE DOT
// https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.3
// Between 'l' (U+006C) characters only, used to permit the Catalan character ela geminada to be expressed.
// note: this a lot of effort for 1 character
// 20221020: disabled
function check_middle_dot(cps) {
	let i = 0;
	while (true) {
		i = cps.indexOf(0xB7, i);
		if (i == -1) break;
		if (cps[i-1] !== 0x6C || cps[i+1] !== 0x6C) throw new Error('ContextO: middle dot');
		i += 2;
	}
}
*/

function check_scripts(cps) {
	for (let {name, test, rest, allow, deny, wholes} of ORDERED) {
		if (cps.some(cp => test.some(set => set.has(cp)))) {
			for (let cp of cps) {
				// https://www.unicode.org/reports/tr39/#mixed_script_confusables
				if (!rest.some(set => set.has(cp)) && !allow.has(cp)) {
					throw new Error(`mixed-script ${name} confusable: "${safe_str_from_cps([cp])}"`);
				}
				// https://www.unicode.org/reports/tr39/#single_script_confusables
				if (deny.has(cp)) {
					throw new Error(`single-script ${name} confusable: "${safe_str_from_cps([cp])}"`);
				}
			}
			// https://www.unicode.org/reports/tr39/#def_whole_script_confusables
			if (cps.every(cp => wholes.has(cp) || SCRIPTS[0].has(cp))) {
				throw new Error(`whole-script ${name} confusable`);
			}
			return name;
		}
	}
	return COMMON;
}

// requires decomposed codepoints
// returns true if pure (emoji or single script)
function check_restricted_scripts(cps) {
	// https://www.unicode.org/reports/tr31/#Table_Candidate_Characters_for_Exclusion_from_Identifiers
	cps = cps.filter(cp => cp != FE0F); // remove emoji (once)
	if (!cps.length) return true; // purely emoji
	for (let set of RESTRICTED) {
		if (cps.some(cp => set.has(cp))) { // first with one match
			if (!cps.every(cp => set.has(cp))) { // must match all
				throw new Error(`restricted script cannot mix`);
			}
			if (cps.every(cp => RESTRICTED_WHOLES.has(cp))) {
				throw new Error(`restricted whole-script confusable`);
			}
			return true;
		}
	}
}


function check_leading_combining_mark(cps) {
	if (CM.has(cps[0])) throw new Error(`leading combining mark`);
}
// requires decomposed codepoints
function check_combining_marks(cps) {
	for (let i = 1, j = -1; i < cps.length; i++) {
		if (CM.has(cps[i])) {
			let prev = cps[i - 1];
			if (prev == FE0F) {
				throw new Error(`emoji + combining mark`); // we dont know the full emoji length efficiently 
			}
			let seqs = CM_WHITELIST.get(prev);
			if (seqs) {
				let k = i + 1;
				while (k < cps.length && CM.has(cps[k])) k++;
				let cms = cps.slice(i, k);
				let match = seqs.find(seq => !compare_arrays(seq, cms));
				if (!match) {
					throw new Error(`disallowed combining mark sequence: "${str_from_cps(cps.slice(i-1, k))}"`)
				}
				i = k; 
			} else if (i == j) { 
				// this needs to come after whitelist test since it can permit 2+
				throw new Error(`adjacent combining marks "${str_from_cps(cps.slice(i-2, i+1))}"`);
			} else {
				j = i + 1;
			}
		}
	}
}

function is_printable_mark(cp) {
	return CM.has(cp) || CM_INVALID.has(cp);
}

function should_escape(cp) {
	return ESCAPE.has(cp);
}

function ens_normalize_fragment(frag, nf = nfc) {
	return frag.split(STOP_CH).map(label => str_from_cps(nf(process(explode_cp(label))))).join(STOP_CH);
}

function ens_normalize(name) {
	return flatten(ens_split(name));
}

function ens_beautify(name) {
	let split = ens_split(name, x => x);
	for (let {script, output} of split) {
		if (script !== 'Greek') {
			let prev = 0;
			while (true) {
				let next = output.indexOf(0x3BE, prev);
				if (next < 0) break;
				output[next] = 0x39E; // ξ => Ξ if not greek
				prev = next + 1;
			}
		}
	}
	return flatten(split);
}

function ens_split(name, emoji_filter = filter_fe0f) {
	let offset = 0;
	return name.split(STOP_CH).map(label => {
		let input = explode_cp(label);
		let info = {
			input,
			offset, // codepoint, not string!
		};
		offset += input.length + 1;
		try {
			let mapped = info.mapped = process(input);
			let norm = info.output = nfc(mapped.flatMap(x => Array.isArray(x) ? emoji_filter(x) : x)); // strip FE0F from emoji
			info.emoji = mapped.some(x => Array.isArray(x)); // idea: count emoji? mapped.reduce((a, x) => a + (Array.isArray(x)?1:0), 0);
			check_leading_underscore(norm); // should restricted get underscores? (20221018: no)
			check_leading_combining_mark(norm);
			check_label_extension(norm);
			let decomp = nfd(mapped.map(x => Array.isArray(x) ? FE0F : x)); // replace emoji with single character placeholder
			if (check_restricted_scripts(decomp)) {
				info.script = mapped.every(x => Array.isArray(x)) ? COMMON : 'Restricted'; // name might be all emoji
			} else {
				check_combining_marks(decomp);
				check_surrounding(norm, 0x2019, 'apostrophe', true, true); // question: can this be generalized better?
				//check_middle_dot(norm);
				info.script = check_scripts(nfc(mapped.flatMap(x => Array.isArray(x) ? [] : x))); // remove emoji
			}
		} catch (err) {
			info.error = err.message;
		}
		return info;
	});
}

// throw on first error
function flatten(split) {
	return split.map(({input, error, output}) => {
		// don't print label again if just a single label
		if (error) throw new Error(split.length == 1 ? error : `Invalid label "${safe_str_from_cps(input)}": ${error}`);
		return str_from_cps(output);
	}).join(STOP_CH);
}

function process(input) {
	let ret = []; 
	input = input.slice().reverse(); // flip so we can pop
	while (input.length) {
		let emoji = consume_emoji_reversed(input);
		if (emoji) {
			ret.push(emoji);
		} else {
			let cp = input.pop();
			if (VALID.has(cp)) {
				ret.push(cp);
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					ret.push(...cps);
				} else if (!IGNORED.has(cp)) {
					let form = should_escape(cp) ? '' : ` "${safe_str_from_cps([cp])}"`;
					throw new Error(`disallowed character:${form} ${quote_cp(cp)}`); 
				}
			}
		}
	}
	return ret;
}

function filter_fe0f(cps) {
	return cps.filter(cp => cp != FE0F);
}

function consume_emoji_reversed(cps, eaten) {
	let node = EMOJI_ROOT;
	let emoji;
	let saved;
	let stack = [];
	let pos = cps.length;
	if (eaten) eaten.length = 0; // clear input buffer (if needed)
	while (pos) {
		let cp = cps[--pos];
		let br = node.branches.find(x => x.set.has(cp));
		if (!br) break;
		node = br.node;
		if (node.save) { // remember
			saved = cp;
		} else if (node.check) { // check exclusion
			if (cp === saved) break;
		}
		stack.push(cp);
		if (node.fe0f) {
			stack.push(FE0F);
			if (pos > 0 && cps[pos - 1] == FE0F) pos--; // consume optional FE0F
		}
		if (node.valid) { // this is a valid emoji (so far)
			emoji = conform_emoji_copy(stack, node);
			if (eaten) eaten.push(...cps.slice(pos).reverse()); // copy input (if needed)
			cps.length = pos; // truncate
		}
	}
	if (!emoji) {
		let cp = cps[cps.length-1];
		if (EMOJI_SOLO.has(cp)) {
			if (eaten) eaten.push(cp);
			emoji = [cp];
			cps.pop();
		}
	}
	return emoji;
}

// create a copy and fix any unicode quirks
function conform_emoji_copy(cps, node) {
	let copy = cps.slice(); // copy stack
	if (node.valid == 2) copy.splice(1, 1); // delete FE0F at position 1 (see: make.js)
	return copy;
}

// return all supported emoji
function ens_emoji() {
	let ret = [...EMOJI_SOLO].map(x => [x]);
	build(EMOJI_ROOT, []);
	return ret.sort(compare_arrays);
	function build(node, cps, saved) {
		if (node.save) { // remember
			saved = cps[cps.length-1];
		} else if (node.check) { // check exclusion
			if (saved === cps[cps.length-1]) return;
		}
		if (node.fe0f) cps.push(FE0F);
		if (node.valid) ret.push(conform_emoji_copy(cps, node));
		for (let br of node.branches) {
			for (let cp of br.set) {
				build(br.node, [...cps, cp], saved);
			}
		}
	}
}

// ************************************************************
// tokenizer 

const TY_VALID = 'valid';
const TY_MAPPED = 'mapped';
const TY_IGNORED = 'ignored';
const TY_DISALLOWED = 'disallowed';
const TY_EMOJI = 'emoji';
const TY_NFC = 'nfc';
const TY_STOP = 'stop';

function ens_tokenize(name, {
	nf = true, // collapse unnormalized runs into a single token
} = {}) {
	let input = explode_cp(name).reverse();
	let eaten = [];
	let tokens = [];
	while (input.length) {		
		let emoji = consume_emoji_reversed(input, eaten);
		if (emoji) {
			tokens.push({type: TY_EMOJI, emoji, input: eaten.slice(), cps: filter_fe0f(emoji)});
		} else {
			let cp = input.pop();
			if (cp === STOP) {
				tokens.push({type: TY_STOP, cp});
			} else if (VALID.has(cp)) {
				/*
				if (CM_WHITELIST.get(cp) === CM_ISOLATED_PH) {
					tokens.push({type: TY_ISOLATED, cp});
				} else {
					tokens.push({type: TY_VALID, cps: [cp]});
				}
				*/
				tokens.push({type: TY_VALID, cps: [cp]});
			} else if (IGNORED.has(cp)) {
				tokens.push({type: TY_IGNORED, cp});
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					tokens.push({type: TY_MAPPED, cp, cps: cps.slice()});
				} else {
					tokens.push({type: TY_DISALLOWED, cp});
				}
			}
		}
	}
	if (nf) {
		for (let i = 0, start = -1; i < tokens.length; i++) {
			let token = tokens[i];
			if (is_valid_or_mapped(token.type)) {
				if (requires_check(token.cps)) { // normalization might be needed
					let end = i + 1;
					for (let pos = end; pos < tokens.length; pos++) { // find adjacent text
						let {type, cps} = tokens[pos];
						if (is_valid_or_mapped(type)) {
							if (!requires_check(cps)) break;
							end = pos + 1;
						} else if (type !== TY_IGNORED) { // || type !== TY_DISALLOWED) { 
							break;
						}
					}
					if (start < 0) start = i;
					let slice = tokens.slice(start, end);
					let cps0 = slice.flatMap(x => is_valid_or_mapped(x.type) ? x.cps : []); // strip junk tokens
					let cps = nfc(cps0);
					if (compare_arrays(cps, cps0)) { // bundle into an nfc token
						tokens.splice(start, end - start, {type: TY_NFC, input: cps0, cps, tokens: collapse_valid_tokens(slice)});
						i = start;
					} else { 
						i = end - 1; // skip to end of slice
					}
					start = -1; // reset
				} else {
					start = i; // remember last
				}
			} else if (token.type === TY_EMOJI) { // 20221024: is this correct?
				start = -1; // reset
			}
		}
	}
	return collapse_valid_tokens(tokens);
}

function is_valid_or_mapped(type) {
	return type === TY_VALID || type === TY_MAPPED;
}

function requires_check(cps) {
	return cps.some(cp => NFC_CHECK.has(cp));
}

function collapse_valid_tokens(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type === TY_VALID) {
			let j = i + 1;
			while (j < tokens.length && tokens[j].type === TY_VALID) j++;
			tokens.splice(i, j - i, {type: TY_VALID, cps: tokens.slice(i, j).flatMap(x => x.cps)});
		}
	}
	return tokens;
}

export { ens_beautify, ens_emoji, ens_normalize, ens_normalize_fragment, ens_split, ens_tokenize, is_printable_mark, nfc, nfd, safe_str_from_cps, should_escape };
