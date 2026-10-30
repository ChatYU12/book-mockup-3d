/* 书模台 —— 教材封面 3D 打样
 * 纯前端：three.js 内嵌，图片不出浏览器。
 * 尺寸恒定 185 × 260 × 10 mm（内部 1 单位 = 1 mm）。
 */
(function () {
  'use strict';

  var THREE = window.THREE;
  var $ = function (id) { return document.getElementById(id); };

  // ── 常量 ────────────────────────────────────────────────────────────
  var MM = { W: 185, H: 260, T: 10 };   // 宽 / 高 / 厚（mm）
  var FOLD_R = 1.2;                     // 封面与书脊之间的折角半径（mm）
  var FOV = 30;
  var PAPER_TILE = 4;                   // 纸页纹理单元 = 4 mm
  var MAX_TEX_SIDE = 2560;      // 拼接贴图长边上限（4000px 导出时书宽约 1600px，够用）
  var MAX_TEX_AREA = 6.5e6;     // 像素总数上限，防止大图把纹理上传拖到几秒
  var SPINE_TOL = 0.05;                 // 书脊比例容差 5%

  var PRESETS = {
    front:  { label: '正面平视',      pose: 'stand', theta: 0,   phi: 3,  dist: 665 },
    left30: { label: '左前 30°',       pose: 'stand', theta: -30, phi: 6,  dist: 690 },
    left45: { label: '左前 45° 略俯',  pose: 'stand', theta: -45, phi: 20, dist: 730 },
    table:  { label: '平放台面',      pose: 'flat',  theta: -22, phi: 42, dist: 660 },
    stack2: { label: '堆叠两本',      pose: 'stack', theta: -18, phi: 40, dist: 620 }
  };

  var BG_LABEL = {
    none: '透明', studio: '浅灰影棚', white: '纯白无缝',
    wood: '木质桌面', gradient: '浅色渐变', custom: '自定义图'
  };

  // ── 状态 ────────────────────────────────────────────────────────────
  var S = {
    cover: null,          // {bmp,w,h,name,url}
    spine: null,
    bgImage: null,        // {bmp,w,h}
    preset: 'front',
    bg: 'none',
    longEdge: 3000,
    spineMode: 'crop',    // 'crop' | 'stretch'
    spineBad: false,
    coverStem: 'book'
  };

  // ── 渲染层 ──────────────────────────────────────────────────────────
  var renderer, scene, camera, canvasEl;
  var stageGroup, bookRoot, ground, contactMesh, keyLight, fillLight;
  var coverMat, pageMat, paperTex, envRT;
  var geos = null;
  var compositeCanvas = null, seamX = 0;
  var bgTex = null;
  var dirty = true;
  var readyResolve, readyPromise;

  var cam = { theta: 0, phi: 0.05, dist: 700 };
  var camTgt = { theta: 0, phi: 0.05, dist: 700 };
  var camAnim = null;                 // 预设切换用的定时动画（保证 300ms 内到位）
  var target = new THREE.Vector3(0, 130, 0);

  readyPromise = new Promise(function (res) { readyResolve = res; });

  // ── 工具 ────────────────────────────────────────────────────────────
  function toast(msg, kind, ms) {
    var wrap = $('toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .2s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 220);
    }, ms || 3200);
  }

  var PERF = {};
  function mark(name) {
    if (!PERF.t0) PERF.t0 = performance.now();
    PERF[name] = Math.round(performance.now() - PERF.t0);
  }

  function fmtRatio(w, h) {
    var g = gcd(w, h);
    return (w / g) + ' : ' + (h / g);
  }

  function gcd(a, b) { a = Math.round(a); b = Math.round(b); return b ? gcd(b, a % b) : a; }

  // ── 图片加载 ────────────────────────────────────────────────────────
  function decodeImage(blob) {
    var url = URL.createObjectURL(blob);
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(blob).then(function (bmp) {
        return { bmp: bmp, url: url };
      }).catch(function () { return decodeViaImg(url); });
    }
    return decodeViaImg(url);
  }

  function decodeViaImg(url) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res({ bmp: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  // 缩略图：把原图缩到 88×124 的小 canvas，别让 <img> 去缩放几百万像素的大图
  function makeThumb(img) {
    try {
      var w = 88, h = 124;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var g = cv.getContext('2d');
      g.fillStyle = '#0c0f10';
      g.fillRect(0, 0, w, h);
      var k = Math.max(w / img.w, h / img.h);
      var dw = img.w * k, dh = img.h * k;
      g.drawImage(img.bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
      return cv.toDataURL('image/png');
    } catch (e) {
      return img.url || '';
    }
  }

  function sizeOf(bmp) {
    return { w: bmp.width || bmp.naturalWidth, h: bmp.height || bmp.naturalHeight };
  }

  async function acceptFile(kind, file) {
    mark('upload:start');
    if (!file) return;
    if (file.type && ['image/png', 'image/jpeg'].indexOf(file.type) < 0) {
      toast('只支持 PNG / JPG 图片', 'err');
      return;
    }
    var decoded;
    try {
      decoded = await decodeImage(file);
    } catch (e) {
      toast('这张图打不开，换一张试试', 'err');
      return;
    }
    mark('upload:decode');
    var sz = sizeOf(decoded.bmp);
    if (Math.max(sz.w, sz.h) < 400) {
      toast('图片太小（' + sz.w + ' × ' + sz.h + '），效果会糊', 'warn');
    }
    applyImage(kind, {
      bmp: decoded.bmp,
      w: sz.w,
      h: sz.h,
      name: file.name || 'image',
      url: decoded.url || null
    });
  }

  function applyImage(kind, img) {
    var prev = S[kind];
    if (prev && prev.url) URL.revokeObjectURL(prev.url);
    if (prev && prev.bmp && prev.bmp.close) prev.bmp.close();

    if (kind === 'cover') {
      S.cover = img;
      S.coverStem = (img.name || 'book').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '') || 'book';
      $('thumbCover').src = makeThumb(img);
      $('thumbCover').classList.remove('empty');
      $('metaCover').textContent = img.w + ' × ' + img.h + ' px · ' +
        (img.w / img.h).toFixed(3) + ' : 1';
      $('metaCover').className = 'drop-meta ok';
    } else {
      S.spine = img;
      $('thumbSpine').src = makeThumb(img);
      $('thumbSpine').classList.remove('empty');
      checkSpineRatio();
    }

    delete PERF['upload:firstframe'];
    rebuildBookSurface();
    mark('upload:composite');
    $('emptyState').hidden = !!S.cover;
    $('exportBtn').disabled = !S.cover;
    $('uploadAside').textContent = S.cover ? (S.spine ? '已就位' : '缺书脊') : '未上传';
    dirty = true;
  }

  function checkSpineRatio() {
    var sp = S.spine;
    if (!sp) { S.spineBad = false; $('spineWarn').hidden = true; return; }
    var want = MM.T / MM.H;                 // 0.03846
    var got = sp.w / sp.h;
    var dev = Math.abs(got / want - 1);
    S.spineBad = dev > SPINE_TOL;

    if (!S.spineBad) {
      $('metaSpine').textContent = sp.w + ' × ' + sp.h + ' px · 比例 ' +
        (got * 1000).toFixed(1) + ' : 1000 · 符合 10 : 260';
      $('metaSpine').className = 'drop-meta ok';
      $('spineWarn').hidden = true;
      return;
    }

    var ideal = Math.round(sp.h * want);
    $('metaSpine').textContent = sp.w + ' × ' + sp.h + ' px · 比例 ' +
      fmtRatio(sp.w, sp.h) + ' · 偏差 ' + Math.round(dev * 100) + '%';
    $('metaSpine').className = 'drop-meta bad';
    $('spineWarnBody').textContent =
      '这张图是 ' + sp.w + ' × ' + sp.h + ' px（约 ' + fmtRatio(sp.w, sp.h) +
      '）。按 10 : 260 应该约 ' + ideal + ' × ' + sp.h + ' px。直接用会把书名压扁或拉长。';
    $('spineWarn').hidden = false;
  }

  // ── 拼接贴图：封面右边缘紧接书脊左边缘 ──────────────────────────────
  function rebuildBookSurface() {
    if (!S.cover || !renderer) return;

    var c = S.cover;
    var nominalW = c.w + c.h * (MM.T / MM.H);
    var scale = Math.min(
      1,
      MAX_TEX_SIDE / Math.max(nominalW, c.h),
      Math.sqrt(MAX_TEX_AREA / (nominalW * c.h))
    );

    var ch = Math.max(8, Math.round(c.h * scale));
    var cw = Math.max(8, Math.round(c.w * scale));
    var sw = Math.max(2, Math.round(c.h * (MM.T / MM.H) * scale));

    var cv = document.createElement('canvas');
    cv.width = cw + sw;
    cv.height = ch;
    var g = cv.getContext('2d');
    g.fillStyle = '#ece9e0';
    g.fillRect(0, 0, cv.width, ch);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';

    // 封面：占 0 .. cw
    g.drawImage(c.bmp, 0, 0, cw, ch);

    // 书脊：占 cw .. cw+sw（左边缘与封面右边缘紧邻，像素级连续）
    if (S.spine) {
      var sp = S.spine;
      if (S.spineMode === 'stretch') {
        // 用户明确选了拉伸：按 10 : 260 强行填满
        g.drawImage(sp.bmp, cw, 0, sw, ch);
      } else {
        // 等比缩放 + 居中裁切：比例正确时即 1:1，不裁
        drawCoverFit(g, sp.bmp, sp.w, sp.h, cw, 0, sw, ch);
      }
    }

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;

    compositeCanvas = cv;
    seamX = cw;

    if (coverMat) {
      if (coverMat.map) coverMat.map.dispose();
      coverMat.map = tex;
      coverMat.needsUpdate = true;
    }

    if (!bookRoot && S.cover) buildStage();
    dirty = true;
  }

  function drawCoverFit(g, bmp, bw, bh, dx, dy, dw, dh) {
    g.save();
    g.beginPath();
    g.rect(dx, dy, dw, dh);
    g.clip();
    var k = Math.max(dw / bw, dh / bh);
    var w = bw * k, h = bh * k;
    g.drawImage(bmp, dx + (dw - w) / 2, dy + (dh - h) / 2, w, h);
    g.restore();
  }

  // ── 纸页纹理（程序生成）─────────────────────────────────────────────
  function makePaperTexture() {
    var N = 512;
    var cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    var g = cv.getContext('2d');
    g.fillStyle = '#f3efe3';
    g.fillRect(0, 0, N, N);

    var bands = 40;
    var bw = N / bands;
    for (var i = 0; i < bands; i++) {
      var t = Math.random();
      var x = i * bw;
      g.fillStyle = 'rgba(' + (196 + t * 34).toFixed(0) + ',' +
        (190 + t * 32).toFixed(0) + ',' + (172 + t * 30).toFixed(0) + ',' +
        (0.10 + t * 0.18).toFixed(3) + ')';
      g.fillRect(x, 0, bw * 0.66, N);
      g.fillStyle = 'rgba(126,118,100,' + (0.10 + t * 0.10).toFixed(3) + ')';
      g.fillRect(x + bw * 0.84, 0, Math.max(1, bw * 0.12), N);
    }

    // 细颗粒
    var img = g.getImageData(0, 0, N, N);
    var d = img.data;
    for (var p = 0; p < d.length; p += 4) {
      var n = (Math.random() - 0.5) * 9;
      d[p] += n; d[p + 1] += n; d[p + 2] += n * 0.8;
    }
    g.putImageData(img, 0, 0);

    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
  }

  // ── 几何：封面 + 折角 + 书脊（连续 UV）──────────────────────────────
  function buildCoverGeometry() {
    var W = MM.W, H = MM.H, T = MM.T, R = FOLD_R;
    var cross = [];
    cross.push({ x: -W / 2, z: T / 2, s: 0 });
    cross.push({ x: W / 2 - R, z: T / 2, s: W - R });
    var cx = W / 2 - R, cz = T / 2 - R;
    var NARC = 12;
    for (var i = 1; i <= NARC; i++) {
      var th = (i / NARC) * Math.PI / 2;
      cross.push({
        x: cx + R * Math.sin(th),
        z: cz + R * Math.cos(th),
        s: (W - R) + R * th
      });
    }
    var s2 = (W - R) + R * Math.PI / 2;
    cross.push({ x: W / 2, z: -T / 2, s: s2 + (T - R) });
    var S_ = s2 + (T - R);

    var pos = [], uv = [], idx = [];
    for (var k = 0; k < cross.length; k++) {
      for (var j = 0; j < 2; j++) {
        var y = j === 0 ? -H / 2 : H / 2;
        pos.push(cross[k].x, y, cross[k].z);
        uv.push(cross[k].s / S_, j === 0 ? 0 : 1);
      }
    }
    for (var q = 0; q < cross.length - 1; q++) {
      var a = q * 2, b = q * 2 + 1, c2 = (q + 1) * 2, d = (q + 1) * 2 + 1;
      idx.push(a, d, b, a, c2, d);
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  // ── 几何：四个纸页面（封底 + 书口 + 天头 + 地脚）────────────────────
  function buildPagesGeometry() {
    var W = MM.W, H = MM.H, T = MM.T, P = PAPER_TILE;
    var pos = [], uv = [], idx = [];
    var V = function (x, y, z) { return new THREE.Vector3(x, y, z); };

    function quad(o, u, v, uRep, vRep) {
      var base = pos.length / 3;
      var pts = [o, o.clone().add(u), o.clone().add(u).add(v), o.clone().add(v)];
      var uvs = [[0, 0], [uRep, 0], [uRep, vRep], [0, vRep]];
      var n = new THREE.Vector3().crossVectors(u, v).normalize();
      var mid = o.clone().add(u.clone().multiplyScalar(0.5)).add(v.clone().multiplyScalar(0.5));
      var flip = n.dot(mid) < 0;
      for (var i = 0; i < 4; i++) {
        pos.push(pts[i].x, pts[i].y, pts[i].z);
        uv.push(uvs[i][0], uvs[i][1]);
      }
      if (!flip) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    }

    // 书口（x = -W/2）：条纹沿厚度方向（z）排布
    quad(V(-W / 2, -H / 2, -T / 2), V(0, 0, T), V(0, H, 0), T / P, H / P);
    // 天头（y = +H/2）
    quad(V(-W / 2, H / 2, -T / 2), V(0, 0, T), V(W, 0, 0), T / P, W / P);
    // 地脚（y = -H/2）
    quad(V(-W / 2, -H / 2, -T / 2), V(0, 0, T), V(W, 0, 0), T / P, W / P);
    // 封底（z = -T/2）
    quad(V(-W / 2, -H / 2, -T / 2), V(W, 0, 0), V(0, H, 0), W / P, H / P);

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  }

  function getGeos() {
    if (!geos) geos = { cover: buildCoverGeometry(), pages: buildPagesGeometry() };
    return geos;
  }

  // ── 环境贴图（程序生成的影棚 HDRI 近似）────────────────────────────
  function buildEnvironment() {
    var W = 1024, H = 512;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');

    var vg = g.createLinearGradient(0, 0, 0, H);
    vg.addColorStop(0, '#ffffff');
    vg.addColorStop(0.42, '#f2f0ea');
    vg.addColorStop(0.53, '#c6c3bb');
    vg.addColorStop(1, '#3e3b36');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);

    // 左上的柔光箱
    var soft = g.createRadialGradient(W * 0.30, H * 0.26, 8, W * 0.30, H * 0.26, W * 0.30);
    soft.addColorStop(0, 'rgba(255,255,255,1)');
    soft.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    soft.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = soft;
    g.fillRect(0, 0, W, H);

    // 右侧反光板：书脊折角处的一道光
    var side = g.createLinearGradient(W * 0.62, 0, W * 0.9, 0);
    side.addColorStop(0, 'rgba(255,255,255,0)');
    side.addColorStop(0.45, 'rgba(255,252,246,0.72)');
    side.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = side;
    g.fillRect(W * 0.6, H * 0.12, W * 0.34, H * 0.5);

    var tex = new THREE.CanvasTexture(cv);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;

    var pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    var rt = pmrem.fromEquirectangular(tex);
    envRT = rt;
    scene.environment = rt.texture;
    tex.dispose();
    pmrem.dispose();
  }

  // ── 接触阴影（alpha 渐变）──────────────────────────────────────────
  function makeContactTexture() {
    var N = 256;
    var cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    var g = cv.getContext('2d');
    var rg = g.createRadialGradient(N / 2, N / 2, N * 0.06, N / 2, N / 2, N * 0.5);
    rg.addColorStop(0, 'rgba(0,0,0,0.62)');
    rg.addColorStop(0.45, 'rgba(0,0,0,0.34)');
    rg.addColorStop(0.75, 'rgba(0,0,0,0.10)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, N, N);
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ── 场景初始化 ─────────────────────────────────────────────────────
  function init() {
    mark('boot');
    canvasEl = $('view');

    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvasEl,
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance'
      });
    } catch (e) {
      fail('这台浏览器没有可用的 WebGL，无法渲染 3D 书模。请换 Chrome / Edge / Safari 最新版。');
      return;
    }
    if (!renderer) {
      fail('这台浏览器没有可用的 WebGL。');
      return;
    }

    mark('renderer');
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(FOV, 1, 5, 20000);

    buildEnvironment();
    mark('env');

    keyLight = new THREE.DirectionalLight(0xfff8ee, 1.95);
    keyLight.position.set(300, 900, 430);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.bias = -0.0007;
    keyLight.shadow.normalBias = 0.6;
    var sc = keyLight.shadow.camera;
    sc.left = -380; sc.right = 380; sc.top = 420; sc.bottom = -220;
    sc.near = 100; sc.far = 2600;
    sc.updateProjectionMatrix();
    scene.add(keyLight);

    fillLight = new THREE.DirectionalLight(0xdfe8f0, 0.5);
    fillLight.position.set(-520, 260, 300);
    scene.add(fillLight);

    ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.24 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.08;
    ground.receiveShadow = true;
    scene.add(ground);

    mark('lights');
    paperTex = makePaperTexture();
    mark('paper');

    coverMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.44,
      metalness: 0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
      envMapIntensity: 1.1
    });
    pageMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: paperTex,
      roughness: 0.92,
      metalness: 0,
      envMapIntensity: 0.45
    });

    stageGroup = new THREE.Group();
    scene.add(stageGroup);

    contactMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeContactTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 1
      })
    );
    contactMesh.rotation.x = -Math.PI / 2;
    contactMesh.position.y = 0.06;
    contactMesh.visible = false;
    scene.add(contactMesh);

    mark('materials');
    bindUI();
    resize();
    mark('bind');
    applyPreset(S.preset, true);
    applyBackground();

    new ResizeObserver(function () { resize(); }).observe($('stage'));
    window.addEventListener('resize', resize);

    requestAnimationFrame(loop);
    setTimeout(function () {
      renderFrame();
      mark('firstFrame');
      readyResolve();
    }, 0);
  }

  function fail(msg) {
    var es = $('emptyState');
    es.hidden = false;
    es.innerHTML = '<div class="es-title">渲染不可用</div><div class="es-body">' + msg + '</div>';
    toast(msg, 'err', 8000);
  }

  // ── 书的组装 ───────────────────────────────────────────────────────
  function createBook() {
    var g = getGeos();
    var grp = new THREE.Group();

    var cover = new THREE.Mesh(g.cover, coverMat);
    cover.castShadow = true;
    cover.receiveShadow = true;
    grp.add(cover);

    var pages = new THREE.Mesh(g.pages, pageMat);
    pages.castShadow = true;
    pages.receiveShadow = true;
    grp.add(pages);

    return grp;
  }

  function flatWrap(book, dx, dy, dz, rotY) {
    var w = new THREE.Group();
    w.rotation.x = -Math.PI / 2;         // 封面朝上
    book.rotation.y = rotY || 0;
    w.add(book);
    w.position.set(dx, dy, dz);
    return w;
  }

  function buildStage() {
    if (!S.cover) return;
    while (stageGroup.children.length) {
      stageGroup.remove(stageGroup.children[0]);
    }

    var pose = PRESETS[S.preset].pose;
    bookRoot = null;

    if (pose === 'stand') {
      bookRoot = createBook();
      stageGroup.add(bookRoot);
    } else if (pose === 'flat') {
      bookRoot = flatWrap(createBook(), 0, MM.T / 2, 0, 0);
      stageGroup.add(bookRoot);
    } else {
      // 堆叠两本：同一套图，下层略错位、上层微转
      var lower = flatWrap(createBook(), 0, MM.T / 2, 0, 0.045);
      var upper = flatWrap(createBook(), -16, MM.T * 1.5, 9, -0.085);
      stageGroup.add(lower);
      stageGroup.add(upper);
      bookRoot = lower;
    }

    // 让书模坐在地面上，并在水平方向居中
    var box = new THREE.Box3().setFromObject(stageGroup);
    stageGroup.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    stageGroup.updateMatrixWorld(true);

    var bb = new THREE.Box3().setFromObject(stageGroup);
    // 视线中心略高于几何中心，底部留出阴影的空间，避免导出时阴影被画面边缘切出硬边
    target.set(0, bb.min.y + (bb.max.y - bb.min.y) * 0.535, 0);

    // 接触阴影跟随足迹
    var sx = (bb.max.x - bb.min.x) * 1.16;
    var sz = (bb.max.z - bb.min.z) * 1.2;
    contactMesh.scale.set(Math.max(sx, 50), Math.max(sz, 50), 1);
    contactMesh.position.set(0, 0.06, 0);
    contactMesh.visible = true;

    dirty = true;
  }

  // ── 相机 ───────────────────────────────────────────────────────────
  function applyCamera() {
    var t = cam.theta * Math.PI / 180;
    var p = cam.phi * Math.PI / 180;
    var d = cam.dist;
    var x = target.x + d * Math.cos(p) * Math.sin(t);
    var y = target.y + d * Math.sin(p);
    var z = target.z + d * Math.cos(p) * Math.cos(t);
    camera.position.set(x, y, z);
    camera.lookAt(target);
    camera.updateMatrixWorld();

    var td = Math.round(camTgt.theta), pd = Math.round(camTgt.phi);
    $('viewAngle').textContent = (td > 0 ? '+' : '') + td + '° / ' + pd + '°';
  }

  function applyPreset(name, instant) {
    var p = PRESETS[name] || PRESETS.front;
    S.preset = name;
    camTgt.theta = p.theta;
    camTgt.phi = p.phi;
    camTgt.dist = p.dist;

    // 让自由旋转后的角度就近吸附，不做整圈回转
    if (instant) {
      camAnim = null;
      cam.theta = p.theta; cam.phi = p.phi; cam.dist = p.dist;
    } else {
      camAnim = {
        t0: performance.now(),
        dur: 170,
        from: { theta: nearestAngle(cam.theta, p.theta), phi: cam.phi, dist: cam.dist },
        to: { theta: p.theta, phi: p.phi, dist: p.dist }
      };
    }

    var btns = document.querySelectorAll('.preset');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].dataset.preset === name ? 'true' : 'false');
    }

    buildStage();
    if (instant) applyCamera();
    dirty = true;
  }

  function nearestAngle(from, to) {
    var a = from, d = to;
    while (a - d > 180) a -= 360;
    while (a - d < -180) a += 360;
    return a;
  }

  // ── 背景 ───────────────────────────────────────────────────────────
  function bgCanvas(id, w, h) {
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var g = cv.getContext('2d');

    if (id === 'white') {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      var vg = g.createRadialGradient(w * 0.5, h * 0.42, h * 0.12, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
      vg.addColorStop(0, 'rgba(255,255,255,1)');
      vg.addColorStop(1, 'rgba(254,254,253,1)');
      g.fillStyle = vg;
      g.fillRect(0, 0, w, h);
    } else if (id === 'studio') {
      var rg = g.createRadialGradient(w * 0.5, h * 0.38, Math.min(w, h) * 0.06,
        w * 0.5, h * 0.52, Math.max(w, h) * 0.78);
      rg.addColorStop(0, '#f7f7f5');
      rg.addColorStop(0.55, '#e6e5e1');
      rg.addColorStop(1, '#c4c3bf');
      g.fillStyle = rg;
      g.fillRect(0, 0, w, h);
    } else if (id === 'wood') {
      var base = g.createLinearGradient(0, 0, w * 0.2, h);
      base.addColorStop(0, '#9a6c49');
      base.addColorStop(0.55, '#8a5f3f');
      base.addColorStop(1, '#6f4b31');
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);
      // 木纹
      for (var i = 0; i < 220; i++) {
        var y = Math.random() * h;
        g.strokeStyle = 'rgba(' + (58 + Math.random() * 40).toFixed(0) + ',' +
          (36 + Math.random() * 28).toFixed(0) + ',' + (22 + Math.random() * 18).toFixed(0) +
          ',' + (0.03 + Math.random() * 0.09).toFixed(3) + ')';
        g.lineWidth = 0.6 + Math.random() * 2.4;
        g.beginPath();
        g.moveTo(-20, y);
        g.bezierCurveTo(w * 0.3, y + (Math.random() - 0.5) * 26, w * 0.7, y + (Math.random() - 0.5) * 26, w + 20, y + (Math.random() - 0.5) * 14);
        g.stroke();
      }
      // 光斑
      var lg = g.createRadialGradient(w * 0.34, h * 0.18, 10, w * 0.34, h * 0.2, Math.max(w, h) * 0.8);
      lg.addColorStop(0, 'rgba(255,236,206,0.34)');
      lg.addColorStop(1, 'rgba(255,236,206,0)');
      g.fillStyle = lg;
      g.fillRect(0, 0, w, h);
      // 暗角
      var vg2 = g.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.3, w * 0.5, h * 0.5, Math.max(w, h) * 0.8);
      vg2.addColorStop(0, 'rgba(0,0,0,0)');
      vg2.addColorStop(1, 'rgba(28,16,8,0.38)');
      g.fillStyle = vg2;
      g.fillRect(0, 0, w, h);
    } else if (id === 'gradient') {
      var lg2 = g.createLinearGradient(0, 0, w * 0.35, h);
      lg2.addColorStop(0, '#f9f5eb');
      lg2.addColorStop(0.55, '#e8e6de');
      lg2.addColorStop(1, '#c3cec9');
      g.fillStyle = lg2;
      g.fillRect(0, 0, w, h);
      var gl = g.createRadialGradient(w * 0.26, h * 0.2, 10, w * 0.26, h * 0.2, Math.max(w, h) * 0.7);
      gl.addColorStop(0, 'rgba(255,252,242,0.6)');
      gl.addColorStop(1, 'rgba(255,252,242,0)');
      g.fillStyle = gl;
      g.fillRect(0, 0, w, h);
    } else if (id === 'custom' && S.bgImage) {
      var bi = S.bgImage;
      var k = Math.max(w / bi.w, h / bi.h);
      g.drawImage(bi.bmp, (w - bi.w * k) / 2, (h - bi.h * k) / 2, bi.w * k, bi.h * k);
    }
    return cv;
  }

  function makeBgTexture(id, w, h) {
    var cv = bgCanvas(id, w, h);
    var tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    return tex;
  }

  function applyBackground() {
    var id = S.bg;
    if (id === 'none' || !renderer) {
      scene.background = null;
      if (bgTex) { bgTex.dispose(); bgTex = null; }
      $('stage').classList.add('transparent');
    } else {
      var w = 1280;
      var h = Math.max(320, Math.round(1280 / Math.max(0.2, camera.aspect)));
      if (bgTex) bgTex.dispose();
      bgTex = makeBgTexture(id, w, h);
      scene.background = bgTex;
      $('stage').classList.remove('transparent');
    }

    var btns = document.querySelectorAll('.bg');
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute('aria-pressed', btns[i].dataset.bg === id ? 'true' : 'false');
    }
    $('bgAside').textContent = BG_LABEL[id];
    updateExportUI();
    dirty = true;
  }

  // ── 渲染 ───────────────────────────────────────────────────────────
  function resize() {
    var st = $('stage');
    var w = Math.max(1, st.clientWidth);
    var h = Math.max(1, st.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (S.bg !== 'none' && bgTex) {
      bgTex.dispose();
      bgTex = makeBgTexture(S.bg, 1280, Math.max(320, Math.round(1280 / camera.aspect)));
      scene.background = bgTex;
    }
    applyCamera();
    if (camera) updateExportUI();
    dirty = true;
  }

  function renderFrame() {
    if (!renderer) return;
    renderer.render(scene, camera);
  }

  var lastTs = 0;

  function loop(ts) {
    if (!PERF['upload:firstframe'] && PERF['upload:composite']) mark('upload:firstframe');
    requestAnimationFrame(loop);
    if (!renderer) return;

    var dt = lastTs ? Math.min(64, ts - lastTs) / 1000 : 0.016;
    lastTs = ts;

    if (camAnim) {
      // 170ms easeOutCubic：点一下预设，即使低帧率也能在 300ms 内到位
      var t = Math.min(1, (performance.now() - camAnim.t0) / camAnim.dur);
      var e = 1 - Math.pow(1 - t, 3);
      cam.theta = camAnim.from.theta + (camAnim.to.theta - camAnim.from.theta) * e;
      cam.phi = camAnim.from.phi + (camAnim.to.phi - camAnim.from.phi) * e;
      cam.dist = camAnim.from.dist + (camAnim.to.dist - camAnim.from.dist) * e;
      if (t >= 1) camAnim = null;
      applyCamera();
      dirty = true;
      if (dirty) { dirty = false; renderFrame(); }
      return;
    }

    // 拖拽 / 缩放：时间常数 60ms 的阻尼跟随
    var k = 1 - Math.exp(-dt / 0.06);

    var moving = false;
    if (Math.abs(cam.theta - camTgt.theta) > 0.02) {
      cam.theta += (camTgt.theta - cam.theta) * k; moving = true;
    } else cam.theta = camTgt.theta;

    if (Math.abs(cam.phi - camTgt.phi) > 0.02) {
      cam.phi += (camTgt.phi - cam.phi) * k; moving = true;
    } else cam.phi = camTgt.phi;

    if (Math.abs(cam.dist - camTgt.dist) > 0.2) {
      cam.dist += (camTgt.dist - cam.dist) * k; moving = true;
    } else cam.dist = camTgt.dist;

    if (moving) {
      applyCamera();
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      renderFrame();
    }
  }

  // ── 交互 ───────────────────────────────────────────────────────────
  function bindUI() {
    // 上传
    function bindDrop(dropId, inputId, kind) {
      var drop = $(dropId), input = $(inputId);
      input.addEventListener('change', function () {
        if (input.files && input.files[0]) acceptFile(kind, input.files[0]);
        input.value = '';
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) {
          e.preventDefault();
          drop.classList.add('is-over');
        });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        drop.addEventListener(ev, function () { drop.classList.remove('is-over'); });
      });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('is-over');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) acceptFile(kind, f);
      });
    }
    bindDrop('dropCover', 'fileCover', 'cover');
    bindDrop('dropSpine', 'fileSpine', 'spine');

    // 页面整体也接受拖放（拖到画布上就行）
    ['dragover', 'drop'].forEach(function (ev) {
      document.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    document.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f || !/^image\//.test(f.type || '')) return;
      acceptFile(S.cover ? 'spine' : 'cover', f);
    });

    // 书脊比例策略
    var radios = document.querySelectorAll('input[name="spineMode"]');
    for (var i = 0; i < radios.length; i++) {
      radios[i].addEventListener('change', function (e) {
        S.spineMode = e.target.value;
        rebuildBookSurface();
      });
    }

    // 预设视角
    $('presets').addEventListener('click', function (e) {
      var btn = e.target.closest('.preset');
      if (!btn) return;
      applyPreset(btn.dataset.preset, false);
    });

    // 背景
    $('bgs').addEventListener('click', function (e) {
      var btn = e.target.closest('.bg');
      if (!btn) return;
      var id = btn.dataset.bg;
      if (id === 'custom' && !S.bgImage) {
        $('fileBg').click();
        return;
      }
      S.bg = id;
      applyBackground();
    });

    $('fileBg').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      decodeImage(f).then(function (d) {
        var sz = sizeOf(d.bmp);
        S.bgImage = { bmp: d.bmp, w: sz.w, h: sz.h, url: d.url };
        $('swCustom').style.backgroundImage = 'url(' + d.url + ')';
        S.bg = 'custom';
        applyBackground();
        toast('自定义背景已套用', 'ok', 2000);
      }).catch(function () { toast('背景图打不开', 'err'); });
    });

    // 导出尺寸
    $('longEdge').addEventListener('change', function (e) {
      S.longEdge = parseInt(e.target.value, 10);
      updateExportUI();
    });

    $('exportBtn').addEventListener('click', function () { doExport(); });

    // 拖拽旋转 + 滚轮缩放
    var dragging = false, lastX = 0, lastY = 0;
    canvasEl.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      // 打断预设动画时，把当前机位同步成拖拽起点，避免画面跳一下
      if (camAnim) { camTgt.theta = cam.theta; camTgt.phi = cam.phi; camTgt.dist = cam.dist; }
      camAnim = null;
      lastX = e.clientX; lastY = e.clientY;
      canvasEl.setPointerCapture(e.pointerId);
    });
    canvasEl.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - lastX;
      var dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      camTgt.theta = camTgt.theta - dx * 0.42;
      camTgt.phi = Math.max(-12, Math.min(86, camTgt.phi + dy * 0.36));
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      canvasEl.addEventListener(ev, function () { dragging = false; });
    });

    canvasEl.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (camAnim) { camTgt.theta = cam.theta; camTgt.phi = cam.phi; camTgt.dist = cam.dist; }
      camAnim = null;
      var f = Math.exp(e.deltaY * 0.0012);
      camTgt.dist = Math.max(330, Math.min(2800, camTgt.dist * f));
    }, { passive: false });
  }

  function updateExportUI() {
    var transparent = S.bg === 'none';
    $('exportLabel').textContent = transparent ? '导出透明 PNG' : '导出带背景 PNG';
    $('exportNote').textContent = transparent
      ? '透明背景可直接拖进 PPT，接触阴影以 alpha 呈现。'
      : '背景为「' + BG_LABEL[S.bg] + '」，与预览一致。';
    var a = camera ? camera.aspect : 1.6;
    var w, h;
    if (a >= 1) { w = S.longEdge; h = Math.round(S.longEdge / a); }
    else { h = S.longEdge; w = Math.round(S.longEdge * a); }
    $('exportSize').textContent = w + ' × ' + h;
    $('badgeText').textContent = S.longEdge + ' px · ' + (transparent ? '透明' : BG_LABEL[S.bg]);
    $('stageBadge').hidden = !S.cover;
  }

  // ── 导出 ───────────────────────────────────────────────────────────
  function setShadowQuality(high) {
    if (!keyLight) return;
    var size = high ? 4096 : 2048;
    if (keyLight.shadow.mapSize.x === size) return;
    keyLight.shadow.mapSize.set(size, size);
    if (keyLight.shadow.map) {
      keyLight.shadow.map.dispose();
      keyLight.shadow.map = null;
    }
  }

  function renderAt(longEdge, transparent) {
    var _t = [performance.now()];
    var a = camera.aspect;
    var w, h;
    if (a >= 1) { w = longEdge; h = Math.round(longEdge / a); }
    else { h = longEdge; w = Math.round(longEdge * a); }
    w = Math.max(2, w); h = Math.max(2, h);

    var prevPR = renderer.getPixelRatio();
    var prevAspect = camera.aspect;
    var prevBg = scene.background;
    var prevSize = renderer.getSize(new THREE.Vector2());

    setShadowQuality(longEdge >= 3000);
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyCamera();

    _t.push(performance.now());
    var tmpBg = null;
    if (transparent) {
      scene.background = null;
    } else {
      tmpBg = makeBgTexture(S.bg, w, h);
      scene.background = tmpBg;
    }

    renderer.render(scene, camera);
    _t.push(performance.now());
    var url = canvasEl.toDataURL('image/png');
    _t.push(performance.now());
    var alphaProbe = null;
    try {
      var gl = renderer.getContext();
      var buf = new Uint8Array(4);
      gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      alphaProbe = buf[3];
    } catch (e) { /* ignore */ }
    _t.push(performance.now());

    if (typeof PERF === 'object') {
      PERF.export = {
        size: [w, h],
        setup: Math.round(_t[1] - _t[0]),
        render: Math.round(_t[2] - _t[1]),
        toDataURL: Math.round(_t[3] - _t[2]),
        readPixels: Math.round(_t[4] - _t[3])
      };
    }

    // 复原
    if (tmpBg) tmpBg.dispose();
    scene.background = prevBg;
    renderer.setSize(prevSize.x, prevSize.y, false);
    renderer.setPixelRatio(prevPR);
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
    setShadowQuality(false);
    applyCamera();
    renderFrame();

    return { url: url, w: w, h: h, alphaProbe: alphaProbe };
  }

  function doExport() {
    if (!S.cover) return;
    var btn = $('exportBtn');
    btn.disabled = true;
    var transparent = S.bg === 'none';

    setTimeout(function () {
      try {
        var out = renderAt(S.longEdge, transparent);
        var name = S.coverStem + '_' + (PRESETS[S.preset].label || 'view').replace(/[\\/:*?"<>|\s]/g, '') +
          '_' + S.longEdge + 'px.png';
        var a = document.createElement('a');
        a.href = out.url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        toast('已导出 ' + out.w + ' × ' + out.h + ' px', 'ok', 2600);
        if (transparent && out.alphaProbe === 255) {
          toast('这张图导出后没有透明通道，Safari 上可能出现灰底，建议换 Chrome 导出。', 'warn', 7000);
        }
      } catch (e) {
        toast('导出失败：' + (e && e.message ? e.message : '未知错误'), 'err', 6000);
      } finally {
        btn.disabled = false;
      }
    }, 24);
  }

  // ── 调试 / 验证接口 ────────────────────────────────────────────────
  function exposeAPI() {
    window.__book3d = {
      ready: readyPromise,
      loadImage: async function (kind, dataURL) {
        var blob = await (await fetch(dataURL)).blob();
        var d = await decodeImage(blob);
        var sz = sizeOf(d.bmp);
        applyImage(kind, { bmp: d.bmp, w: sz.w, h: sz.h, name: kind + '.png', url: d.url || null });
        return { w: sz.w, h: sz.h, ratioBad: S.spineBad };
      },
      loadCustomBackground: async function (dataURL) {
        var blob = await (await fetch(dataURL)).blob();
        var d = await decodeImage(blob);
        var sz = sizeOf(d.bmp);
        S.bgImage = { bmp: d.bmp, w: sz.w, h: sz.h, url: d.url };
        $('swCustom').style.backgroundImage = 'url(' + (d.url || '') + ')';
        S.bg = 'custom';
        applyBackground();
        return { w: sz.w, h: sz.h };
      },
      setPreset: function (name) { applyPreset(name, true); },
      setBackground: function (id) { S.bg = id; applyBackground(); },
      setLongEdge: function (n) { S.longEdge = n; $('longEdge').value = String(n); updateExportUI(); },
      getState: function () {
        return {
          preset: S.preset, bg: S.bg, longEdge: S.longEdge, spineMode: S.spineMode,
          spineBad: S.spineBad,
          cover: S.cover ? { w: S.cover.w, h: S.cover.h } : null,
          spine: S.spine ? { w: S.spine.w, h: S.spine.h } : null
        };
      },
      getDims: function () {
        var b = new THREE.Box3();
        if (bookRoot) b.setFromObject(bookRoot);
        return {
          nominal: { W: MM.W, H: MM.H, T: MM.T },
          measured: {
            x: b.isEmpty() ? 0 : b.max.x - b.min.x,
            y: b.isEmpty() ? 0 : b.max.y - b.min.y,
            z: b.isEmpty() ? 0 : b.max.z - b.min.z
          }
        };
      },
      renderExport: function (opt) {
        opt = opt || {};
        var longEdge = opt.longEdge || S.longEdge;
        var transparent = opt.transparent !== undefined ? opt.transparent : (S.bg === 'none');
        var out = renderAt(longEdge, transparent);
        return Promise.resolve(out.url);
      },
      getSeamSample: function () {
        if (!compositeCanvas) return null;
        var g = compositeCanvas.getContext('2d');
        var y = Math.floor(compositeCanvas.height / 2);
        var rows = [];
        for (var dx = -3; dx <= 3; dx++) {
          var x = Math.max(0, Math.min(compositeCanvas.width - 1, seamX + dx));
          var d = g.getImageData(x, y, 1, 1).data;
          rows.push([d[0], d[1], d[2]]);
        }
        return { coverW: seamX, rows: rows };
      },
      perf: function () {
        var gl = renderer && renderer.getContext();
        var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
        return {
          marks: PERF,
          gl: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.VERSION) : null)
        };
      },
      tick: function () { applyCamera(); renderFrame(); }
    };
  }

  // ── 启动 ───────────────────────────────────────────────────────────
  if (!THREE) {
    fail('three.js 没有加载成功，页面不完整。');
    return;
  }
  exposeAPI();
  init();
  $('exportBtn').disabled = true;
  updateExportUI();

})();
