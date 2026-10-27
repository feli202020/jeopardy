/* Minimaler QR-Code-Generator (Byte-Modus, Fehlerkorrektur L).
   Eigenstaendig, damit die Seite keine externe Bibliothek laden muss. */
(function (global) {
  'use strict';

  // Galois-Feld GF(256) fuer Reed-Solomon
  var EXP = new Array(512), LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  function rsGenerator(deg) {
    var poly = [1];
    for (var i = 0; i < deg; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gmul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (var j = 0; j < ecLen; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  // [version, Gesamt-Codewords, EC-Codewords/Block, Bloecke G1, Bloecke G2] (EC-Level L)
  var VERSIONS = [
    [1, 26, 7, 1, 0], [2, 44, 10, 1, 0], [3, 70, 15, 1, 0], [4, 100, 20, 1, 0],
    [5, 134, 26, 1, 0], [6, 172, 18, 2, 0], [7, 196, 20, 2, 0], [8, 242, 24, 2, 0],
    [9, 292, 30, 2, 0], [10, 346, 18, 2, 2]
  ];
  var ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  function utf8Bytes(str) {
    var out = [], i, c;
    for (i = 0; i < str.length; i++) {
      c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c < 0xd800 || c >= 0xe000) { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
      else {
        i++;
        var cp = 0x10000 + (((c & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return out;
  }

  function build(text) {
    var bytes = utf8Bytes(text);
    var ver = null, info = null;
    for (var i = 0; i < VERSIONS.length; i++) {
      var v = VERSIONS[i];
      var nblocks = v[3] + v[4];
      var capacity = v[1] - v[2] * nblocks;
      var lenBytes = v[0] < 10 ? 1 : 2;
      if (bytes.length + 1 + lenBytes <= capacity) { ver = v[0]; info = v; break; }
    }
    if (!ver) throw new Error('Text zu lang fuer QR');

    var size = 17 + ver * 4;
    var totalCw = info[1], ecPerBlock = info[2];
    var blocks = info[3] + info[4];
    var dataCw = totalCw - ecPerBlock * blocks;

    var bits = [];
    function put(val, len) { for (var k = len - 1; k >= 0; k--) bits.push((val >> k) & 1); }
    put(4, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    for (var b = 0; b < bytes.length; b++) put(bytes[b], 8);

    var capBits = dataCw * 8;
    for (var t = 0; t < 4 && bits.length < capBits; t++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var pad = [0xec, 0x11], pi = 0;
    while (bits.length < capBits) put(pad[pi++ % 2], 8);

    var cw = [];
    for (var m = 0; m < bits.length; m += 8) {
      var n = 0;
      for (var q = 0; q < 8; q++) n = (n << 1) | bits[m + q];
      cw.push(n);
    }

    var shortLen = Math.floor(dataCw / blocks), extra = dataCw % blocks;
    var dblocks = [], eblocks = [], pos = 0;
    for (var bi = 0; bi < blocks; bi++) {
      var len = shortLen + (bi >= blocks - extra ? 1 : 0);
      var d = cw.slice(pos, pos + len);
      pos += len;
      dblocks.push(d);
      eblocks.push(rsEncode(d, ecPerBlock));
    }
    var out = [];
    var maxLen = 0;
    for (var z = 0; z < dblocks.length; z++) if (dblocks[z].length > maxLen) maxLen = dblocks[z].length;
    for (var c = 0; c < maxLen; c++)
      for (var bb = 0; bb < blocks; bb++)
        if (c < dblocks[bb].length) out.push(dblocks[bb][c]);
    for (var e = 0; e < ecPerBlock; e++)
      for (var b2 = 0; b2 < blocks; b2++) out.push(eblocks[b2][e]);

    var mod = [], res = [];
    for (var y = 0; y < size; y++) {
      mod.push(new Array(size).fill(0));
      res.push(new Array(size).fill(0));
    }
    function setF(x, y, v) {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      mod[y][x] = v; res[y][x] = 1;
    }

    function finder(cx, cy) {
      for (var dy = -1; dy <= 7; dy++) for (var dx = -1; dx <= 7; dx++) {
        var on = (dx >= 0 && dx <= 6 && (dy === 0 || dy === 6)) ||
                 (dy >= 0 && dy <= 6 && (dx === 0 || dx === 6)) ||
                 (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
        setF(cx + dx, cy + dy, on ? 1 : 0);
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    var al = ALIGN[ver] || [];
    for (var ai = 0; ai < al.length; ai++) for (var aj = 0; aj < al.length; aj++) {
      var ax = al[ai], ay = al[aj];
      if (res[ay][ax]) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++)
        setF(ax + dx2, ay + dy2,
          (Math.abs(dx2) === 2 || Math.abs(dy2) === 2 || (dx2 === 0 && dy2 === 0)) ? 1 : 0);
    }

    for (var i2 = 8; i2 < size - 8; i2++) {
      setF(i2, 6, i2 % 2 === 0 ? 1 : 0);
      setF(6, i2, i2 % 2 === 0 ? 1 : 0);
    }
    setF(8, size - 8, 1);

    for (var fi = 0; fi < 9; fi++) {
      if (fi !== 6) { res[fi][8] = 1; res[8][fi] = 1; }
    }
    res[8][8] = 1;
    for (var fj = 0; fj < 8; fj++) {
      res[size - 1 - fj][8] = 1;
      res[8][size - 1 - fj] = 1;
    }

    var bitIdx = 0, dir = -1, row = size - 1;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (var cdx = 0; cdx < 2; cdx++) {
          var xx = col - cdx;
          if (!res[row][xx]) {
            var dark = 0;
            if (bitIdx < out.length * 8) {
              dark = (out[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
              bitIdx++;
            }
            if ((row + xx) % 2 === 0) dark ^= 1; // Maske 0
            mod[row][xx] = dark;
          }
        }
        row += dir;
        if (row < 0 || row >= size) { row -= dir; dir = -dir; break; }
      }
    }

    // Format-Info: EC-Level L + Maske 0
    var fmt = 0x77c4;
    var fbits = [];
    for (var fb = 14; fb >= 0; fb--) fbits.push((fmt >> fb) & 1);
    var coords = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],
                  [7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
    for (var ci = 0; ci < 15; ci++) mod[coords[ci][1]][coords[ci][0]] = fbits[ci];
    for (var k1 = 0; k1 < 7; k1++) mod[size - 1 - k1][8] = fbits[k1];
    for (var k2 = 0; k2 < 8; k2++) mod[8][size - 8 + k2] = fbits[7 + k2];

    return { size: size, modules: mod };
  }

  global.QRCode = {
    build: build,
    draw: function (canvas, text) {
      var qr = build(text);
      var ctx = canvas.getContext('2d');
      var w = canvas.width, quiet = 2;
      var scale = Math.floor(w / (qr.size + quiet * 2)) || 1;
      var off = Math.floor((w - scale * (qr.size + quiet * 2)) / 2);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, canvas.height);
      ctx.fillStyle = '#000';
      for (var y = 0; y < qr.size; y++)
        for (var x = 0; x < qr.size; x++)
          if (qr.modules[y][x])
            ctx.fillRect(off + (x + quiet) * scale, off + (y + quiet) * scale, scale, scale);
    }
  };
})(typeof window !== 'undefined' ? window : this);
