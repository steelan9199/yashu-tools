#!/usr/bin/env bash
# selftest.sh — 一条命令回归本技能全部工具。按副作用判定成败（文件是否生成、退出码是否符合预期），
# 不凭「命令没报错」下结论。
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
fail=0

echo "== fontcheck =="
bash "$DIR/fontcheck.sh" || fail=1

echo "== webshot =="
node "$DIR/webshot.js" "$DIR/test/sample.html" -o "$DIR/test/out.png" --scale 2 --font || fail=1
[ -s "$DIR/test/out.png" ] || { echo "FAIL test/out.png 未生成"; fail=1; }

echo "== mdtables =="
node "$DIR/mdtables.js" "$DIR/test/sample.md" || fail=1
for f in "$DIR/test/sample_t1.png" "$DIR/test/sample_t2.png" "$DIR/test/sample_表格转图.md"; do
  [ -s "$f" ] || { echo "FAIL 缺产物 $(basename "$f")"; fail=1; }
done

echo "== preflight =="
# 应通过：转图产物 md 无残留表格、配图齐（2 张 → 只 WARN 不 FAIL）
node "$DIR/preflight.js" "$DIR/test/sample_表格转图.md" || fail=1
# 应拦截：原文还带表格 → 退出码必须为 1
if node "$DIR/preflight.js" "$DIR/test/sample.md" >/dev/null 2>&1; then
  echo "FAIL preflight 没识别出残留表格"; fail=1
else
  echo "OK 原文残留表格被拦下（退出码 1）"
fi
# 应拦截：svg 引用 + 引用不存在的文件（临时样本放 gitignore 覆盖的 out-* 目录）
BAD="$DIR/test/out-preflight/bad.md"
mkdir -p "$DIR/test/out-preflight"
printf '一段。\n\n![图](a.svg)\n![图](missing.png)\n' > "$BAD"
if node "$DIR/preflight.js" "$BAD" >/dev/null 2>&1; then
  echo "FAIL preflight 没拦下 svg/缺失文件"; fail=1
else
  echo "OK svg 与缺失文件被拦下（退出码 1）"
fi

echo "== 围栏代码块隔离 =="
# mdtables：代码块里的表格示例不转图，只转真表格（fence_t2.png 不许存在）
node "$DIR/mdtables.js" "$DIR/test/fence.md" || fail=1
[ -s "$DIR/test/fence_t1.png" ] || { echo "FAIL fence_t1.png（真表格）没转出来"; fail=1; }
[ -e "$DIR/test/fence_t2.png" ] && { echo "FAIL 代码块里的表格被误转成 fence_t2.png"; fail=1; }
echo "OK mdtables 只转真表格"
# preflight：代码块里的图片示例不数进配图，也不误报残留表格
PF_OUT="$(node "$DIR/preflight.js" "$DIR/test/fence_表格转图.md" --min-images 1 2>&1)"
echo "$PF_OUT" | grep -q 'PASS' || { echo "FAIL fence 转图产物没过 preflight: $PF_OUT"; fail=1; }
echo "$PF_OUT" | grep -q '^FAIL' && { echo "FAIL preflight 把代码块内容算进去了: $PF_OUT"; fail=1; }
echo "OK preflight 忽略代码块内容"

echo "== fontlint =="
node "$DIR/fontlint.js" "$DIR/test/sample.html" || fail=1
if node "$DIR/fontlint.js" "$DIR/test/bad-font.html" >/dev/null 2>&1; then
  echo "FAIL fontlint 没拦下违规字体样本"; fail=1
else
  # 三处违规（第二字体+generic / 700 / 简写 bold）都必须点到名
  BAD_OUT="$(node "$DIR/fontlint.js" "$DIR/test/bad-font.html" 2>&1)"
  for kw in 'Microsoft YaHei' 'sans-serif' 'font-weight:700' 'bold'; do
    echo "$BAD_OUT" | grep -q "$kw" || { echo "FAIL fontlint 漏报 $kw"; fail=1; }
  done
  echo "OK 违规样本三条全被点名"
fi

echo "== transparent =="
# 两块色板 + 中间空隙：色块不透明、空隙全透（RGBA）
printf '<html><body><div id=a style="width:120px;height:80px;background:#c33"></div><div style="width:300px;height:10px"></div><div id=b style="width:200px;height:60px;background:#36c;margin-left:100px"></div></body></html>' > "$DIR/test/out-two.html"
node "$DIR/webshot.js" "$DIR/test/out-two.html" -o "$DIR/test/out-two.png" --selector "#a,#b" --transparent || fail=1
node -e "
const zlib=require('zlib'),fs=require('fs');const b=fs.readFileSync('test/out-two.png');
if(b[25]!==6){console.error('FAIL 透明输出不是 RGBA');process.exit(1)}
let off=8,idat=[];while(off+12<=b.length){const len=b.readUInt32BE(off),t=b.toString('ascii',off+4,off+8);if(t==='IDAT')idat.push(b.subarray(off+8,off+8+len));off+=12+len;if(t==='IEND')break;}
const w=b.readUInt32BE(16),h=b.readUInt32BE(20),raw=zlib.inflateSync(Buffer.concat(idat)),stride=w*4;
const px=Buffer.alloc(h*stride);const paeth=(a,b2,c)=>{const p=a+b2-c,pa=Math.abs(p-a),pb=Math.abs(p-b2),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
for(let y=0;y<h;y++){const f=raw[y*(stride+1)];for(let x=0;x<stride;x++){const r=raw[y*(stride+1)+1+x];const l=x>=4?px[y*stride+x-4]:0;const u=y>0?px[(y-1)*stride+x]:0;const ul=y>0&&x>=4?px[(y-1)*stride+x-4]:0;let v;if(f===0)v=r;else if(f===1)v=r+l;else if(f===2)v=r+u;else if(f===3)v=r+((l+u)>>1);else v=r+paeth(l,u,ul);px[y*stride+x]=v&255;}}
const a=(x,y)=>px[y*stride+x*4+3];
if(a(60,40)!==255||a(250,130)!==255){console.error('FAIL 实色块被误判半透明');process.exit(1)}
if(a(200,20)!==0){console.error('FAIL 空隙没抠透');process.exit(1)}
console.log('OK 透明抠图正确（实色不透明、空隙全透）');" || fail=1

echo "== cover =="
node "$DIR/cover.js" --title "回归测试封面" --subtitle "selftest" -o "$DIR/test/out-cover.png" || fail=1
node -e "const b=require('fs').readFileSync('test/out-cover.png');const w=b.readUInt32BE(16),h=b.readUInt32BE(20);if(w!==1800||h!==766){console.error('FAIL 封面尺寸 '+w+'x'+h+'（应为 1800x766）');process.exit(1)}console.log('OK 封面尺寸 1800x766');" || fail=1

echo "== article 流水线 =="
# 正向：草稿带表格+两张已有配图 → 转表 + 自查全过
node "$DIR/article.js" "$DIR/test/draft.md" || fail=1
[ -s "$DIR/test/draft_表格转图.md" ] || { echo "FAIL 缺交付版 draft_表格转图.md"; fail=1; }
# 负向：临时造一篇「有表格、零配图」的草稿，自查必须拦下（退出码 1）
NOIMG="$DIR/test/out-preflight/noimg.md"
mkdir -p "$DIR/test/out-preflight"
printf '一段。\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n' > "$NOIMG"
if node "$DIR/article.js" "$NOIMG" >/dev/null 2>&1; then
  echo "FAIL 流水线没拦下零配图文章"; fail=1
else
  echo "OK 零配图文章被拦下（退出码 1）"
fi

echo "== artkit =="
# 组件库本体先过字体铁律，再渲染样张验产物
node "$DIR/fontlint.js" "$DIR/artkit.css" "$DIR/artkit-demo.html" || fail=1
node "$DIR/webshot.js" "$DIR/artkit-demo.html" -o "$DIR/test/out-artkit.png" --selector "#demo" --scale 2 --font || fail=1
[ -s "$DIR/test/out-artkit.png" ] || { echo "FAIL test/out-artkit.png 未生成"; fail=1; }
echo "OK artkit 样张渲染"

echo "== factory 配图工厂 =="
# 正向：目录（草稿 md + 两个 html 源）→ 渲染 + 封面 + 转表 + 自查全套
FDIR="$DIR/test/out-factory"
rm -rf "$FDIR" && mkdir -p "$FDIR"
printf '<!doctype html><meta charset="utf-8"><style>body{margin:0;font-family:\x27LXGW WenKai GB\x27}#art{width:320px;height:200px;background:#15264d;color:#f5f0e6;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:400}</style><div id="art">配图一</div>\n' > "$FDIR/img1.html"
printf '<!doctype html><meta charset="utf-8"><!-- shot: #art --><style>body{margin:0;font-family:\x27LXGW WenKai GB\x27}#art{width:320px;height:200px;background:#f4ede0;color:#3a2c18;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:400}</style><div id="art">配图二</div>\n' > "$FDIR/img2.html"
printf '# 工厂冒烟测试\n\n开头一段。\n\n![](img1.png)\n\n中段一段。\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n\n![](img2.png)\n' > "$FDIR/工厂冒烟.md"
node "$DIR/factory.js" "$FDIR" || fail=1
for f in img1.png img2.png 封面.png 工厂冒烟_t1.png 工厂冒烟_表格转图.md; do
  [ -s "$FDIR/$f" ] || { echo "FAIL 缺产物 $f"; fail=1; }
done
echo "OK 工厂正向全套产物齐"
# 负向：两个草稿 → 目录契约必须拦下（退出码 1）
FDIR2="$DIR/test/out-factory2"
rm -rf "$FDIR2" && mkdir -p "$FDIR2"
printf '# 甲\n' > "$FDIR2/a.md"; printf '# 乙\n' > "$FDIR2/b.md"
if node "$DIR/factory.js" "$FDIR2" >/dev/null 2>&1; then
  echo "FAIL 工厂没拦下多草稿目录"; fail=1
else
  echo "OK 多草稿目录被拦下（退出码 1）"
fi

echo "== gifshot 动图 =="
# 正向：最小动画样本 → GIF；断言产物存在 + GIF89a 头 + 0x3B 尾（LZW 可解码性已另用 Chrome ImageDecoder 抽验）
GDIR="$DIR/test/out-gif"
rm -rf "$GDIR" && mkdir -p "$GDIR"
printf '<!doctype html><meta charset="utf-8"><style>body{margin:0}#box{width:80px;height:80px;background:#0b1e3f;position:relative}#ball{position:absolute;left:10px;top:28px;width:16px;height:16px;border-radius:50%%;background:#e8b64c;animation:mv 0.5s ease-in-out infinite alternate}@keyframes mv{from{transform:translateX(0)}to{transform:translateX(40px)}}</style><div id="box"><div id="ball"></div></div>\n' > "$GDIR/anim.html"
node "$DIR/gifshot.js" "$GDIR/anim.html" -o "$GDIR/anim.gif" --frames 6 --duration 1000 --selector "#box" || fail=1
if [ -s "$GDIR/anim.gif" ] && [ "$(head -c 6 "$GDIR/anim.gif")" = "GIF89a" ] && [ "$(tail -c 1 "$GDIR/anim.gif" | od -An -tu1 | tr -d ' ')" = "59" ]; then
  echo "OK gifshot 产物结构齐（GIF89a 头 + 0x3B 尾）"
else
  echo "FAIL gifshot 产物缺失或结构不对"; fail=1
fi
# 负向：无动画页面必须拦下（退出码 1）
printf '<!doctype html><meta charset="utf-8"><div style="width:80px;height:80px;background:#0b1e3f"></div>\n' > "$GDIR/still.html"
if node "$DIR/gifshot.js" "$GDIR/still.html" -o "$GDIR/still.gif" >/dev/null 2>&1; then
  echo "FAIL gifshot 没拦下无动画页面"; fail=1
else
  echo "OK 无动画页面被拦下（退出码 1）"
fi

if [ "$fail" -eq 0 ]; then echo "== PASS 全部回归通过 =="; else echo "== FAIL 有回归未过 =="; fi
exit "$fail"
