#!/usr/bin/env node
/* 把 src/ 下的模板、样式、app.js 和 vendor/three.min.js 内联成一个可双击打开的 index.html */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const guard = (s) => s.replace(/<\/script/gi, '<\\/script');

const tpl = read('src/index.template.html');
const css = read('src/styles.css');
// r160 的 UMD 构建开头是 `console.warn('...'), (function(t,e){...})(...)` 这种逗号表达式，
// 直接把 console.warn 删掉会让后面的 function 变成匿名函数声明（语法错误），所以替换成 0 保留表达式结构。
const three = read('vendor/three.min.js').replace(/^console\.warn\('[^']*'\),/, '0,');
const app = read('src/app.js');

// 内联前先做一次语法检查：只编译不执行，防止再次产出"打不开"的单文件
for (const [name, code] of [['three.min.js', three], ['app.js', app]]) {
  try {
    new vm.Script(code, { filename: name });
  } catch (e) {
    console.error('✗ ' + name + ' 语法错误：' + e.message);
    process.exit(1);
  }
}

const out = tpl
  .replace('/*__CSS__*/', () => css)
  .replace('/*__THREE__*/', () => guard(three))
  .replace('/*__APP__*/', () => guard(app));

// 原子写：先写临时文件再改名，避免别的进程读到半个文件
const tmp = path.join(root, '.index.tmp.html');
fs.writeFileSync(tmp, out);
fs.renameSync(tmp, path.join(root, 'index.html'));

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('index.html  ' + kb(Buffer.byteLength(out)) +
  '  (three ' + kb(Buffer.byteLength(three)) + ' + app ' + kb(Buffer.byteLength(app)) + ')');
