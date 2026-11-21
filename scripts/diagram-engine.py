# -*- coding: utf-8 -*-
"""对话引擎 v2 时序架构图（Pillow 直绘）。横轴=参与者，纵轴=时序（间距已放大便于阅读）。"""

from PIL import Image, ImageDraw, ImageFont
import math

W, H = 1780, 1150
BG = (18, 18, 22)
PANEL = (27, 27, 32)
LANE = (34, 34, 40)
LINE = (78, 76, 72)
TEXT = (233, 230, 225)
DIM = (150, 145, 138)
FAINT = (96, 94, 90)
ACCENT = (216, 185, 138)
GREEN = (127, 176, 105)
BLUE = (118, 164, 212)
RED = (216, 115, 92)
PURPLE = (162, 142, 198)


def f(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


FB = "C:/Windows/Fonts/msyhbd.ttc"
FR = "C:/Windows/Fonts/msyh.ttc"
FM = "C:/Windows/Fonts/consola.ttf"

f_title = f(FB, 30)
f_sub = f(FR, 16)
f_lane = f(FB, 19)
f_msg = f(FR, 15)
f_small = f(FR, 13)
f_mono = f(FM, 12)
f_box = f(FB, 15)
f_body = f(FR, 13)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

d.text((52, 28), "对话引擎 v2 · 一轮对话的时序", font=f_title, fill=TEXT)
d.text((52, 70), "间距已放大以便阅读；括号内为该步实测耗时。", font=f_sub, fill=DIM)

# ---------------- 泳道 ----------------
LANES = [
    (140, 520, "渲染进程 Renderer", "麦克风 / 播放 / 视频"),
    (700, 1090, "主进程 Main", "engine.runTurn + 适配器"),
    (1260, 1730, "云端 Provider", "DeepSeek / MiMo"),
]
TOP = 108
BOT = 880
for x1, x2, name, sub in LANES:
    d.rounded_rectangle([x1, TOP, x2, TOP + 52], radius=8, fill=LANE, outline=LINE)
    tw = d.textlength(name, font=f_lane)
    d.text(((x1 + x2) / 2 - tw / 2, TOP + 7), name, font=f_lane, fill=ACCENT)
    sw = d.textlength(sub, font=f_small)
    d.text(((x1 + x2) / 2 - sw / 2, TOP + 31), sub, font=f_small, fill=DIM)
    d.line([(x1 + x2) / 2, TOP + 52, (x1 + x2) / 2, BOT], fill=(52, 50, 48), width=1)

CX = [(a + b) / 2 for a, b, *_ in LANES]


def msg(y, lane_from, lane_to, text, color=LINE, note="", dashed=False):
    x1, x2 = CX[lane_from], CX[lane_to]

    if x1 == x2:
        x = x1
        d.line([x, y, x + 54, y], fill=color, width=2)
        d.line([x + 54, y, x + 54, y + 30], fill=color, width=2)
        d.line([x + 54, y + 30, x + 12, y + 30], fill=color, width=2)
        for s in (0.5, -0.5):
            d.line([x + 12, y + 30, x + 12 + 13 * math.cos(s), y + 30 + 13 * math.sin(s)], fill=color, width=2)
        d.text((x + 66, y - 6), text, font=f_msg, fill=color)
        if note:
            d.text((x + 66, y + 14), note, font=f_small, fill=DIM)
        return

    sign = 1 if x2 > x1 else -1
    if dashed:
        steps = max(2, int(abs(x2 - x1) / 14))
        for i in range(steps):
            if i % 2:
                continue
            a, b = i / steps, (i + 1) / steps
            d.line([x1 + (x2 - x1) * a, y, x1 + (x2 - x1) * b, y], fill=color, width=1)
    else:
        d.line([x1, y, x2, y], fill=color, width=2)

    for s in (0.45, -0.45):
        d.line([x2, y, x2 - 13 * math.cos(s) * sign, y - 13 * math.sin(s)], fill=color, width=2)

    tw = d.textlength(text, font=f_msg)
    mid = (x1 + x2) / 2 - tw / 2
    d.rectangle([mid - 8, y - 21, mid + tw + 8, y - 2], fill=BG)
    d.text((mid, y - 20), text, font=f_msg, fill=color)
    if note:
        nw = d.textlength(note, font=f_small)
        d.rectangle([(x1 + x2) / 2 - nw / 2 - 6, y + 3, (x1 + x2) / 2 + nw / 2 + 6, y + 19], fill=BG)
        d.text(((x1 + x2) / 2 - nw / 2, y + 4), note, font=f_small, fill=DIM)


# ---------------- 消息（间距 ≥ 46px） ----------------
y = 210
STEP = 64
items = [
    (0, 1, "① asr:transcribe  · PCM16 16k", BLUE, "VAD 判停 700ms 后上传，整段识别"),
    (1, 1, "② ASR 适配器返回文本", BLUE, "DeepSeek 607–670ms · 也可切 MiMo", True),
    (1, 2, "③ POST /chat/completions  stream:true", BLUE, "带 persona 与历史，SSE 返回"),
    (2, 1, "④ token 流（首行 [emotion:xxx] 被剥离）", BLUE, "首 token 387–1275ms"),
    (1, 1, "⑤ 切句 → seq++ → acquire()", ACCENT, "标点含逗号或满 24 字；并发上限 2"),
    (1, 2, "⑥ 逐句 TTS  · audio.format=pcm16", GREEN, "每句独立请求，情绪拼进正文"),
    (2, 1, "⑦ SSE: choices[].delta.audio.data", GREEN, "首包 550–816ms（与字数无关）"),
    (1, 0, "⑧ reply:event  audio{seq,pcm}", ACCENT, "到达即下发，不等整段合成"),
    (0, 0, "⑨ 顺序缓冲 → AudioContext 排程", GREEN, "startAt=max(now,nextPlayAt)；gap>250ms 记日志"),
    (0, 0, "⑩ 首块真正出声 → 视频切 speaking", PURPLE, "按到达时间切，非出声时间（问题点）"),
    (0, 0, "⑪ 队列排空 +900ms → 切 idle", PURPLE, "两句间隔超 900ms 会来回闪"),
]
for lane_a, lane_b, text, color, note, *rest in items:
    dashed = bool(rest and rest[0])
    msg(y, lane_a, lane_b, text, color, note, dashed)
    y += STEP

# ---------------- 底部：三栏 ----------------
PY = 910
d.rounded_rectangle([52, PY, 1720, H - 40], radius=10, fill=(24, 24, 29), outline=(52, 50, 48))

d.text((72, PY + 14), "当前瓶颈（按影响排序）", font=f_box, fill=RED)
rows = [
    ("1", "逗号即切句", "一句回复拆成 2–4 次 TTS → 语气拼缝、请求翻倍"),
    ("2", "LLM 首 token 400–1300ms", "占首声一半以上，只能换模型或压 prompt"),
    ("3", "MiMo 首包固定 ~700ms", "与文本长度无关，改切句无效"),
    ("4", "队列排空后重新起播", "短句音频 < 合成延迟 → 断档；画面先动声后到"),
]
ry = PY + 44
for num, head, desc in rows:
    d.text((74, ry), num, font=f_mono, fill=RED)
    d.text((96, ry - 1), head, font=f_msg, fill=TEXT)
    d.text((360, ry), desc, font=f_small, fill=DIM)
    ry += 27

d.line([900, PY + 14, 900, H - 58], fill=(52, 50, 48), width=1)
d.text((924, PY + 14), "三路 provider（可独立替换）", font=f_box, fill=ACCENT)
provs = [
    ("llm", "deepseek-chat", BLUE),
    ("tts", "mimo-v2.5-tts · 冰糖 · pcm16", GREEN),
    ("asr", "deepseek（MiMo 402 待启用）", RED),
]
py2 = PY + 44
for k, v, col in provs:
    d.text((924, py2), k, font=f_mono, fill=col)
    d.text((968, py2 - 1), v, font=f_small, fill=DIM)
    py2 += 26

d.text((924, PY + 132), "引擎参数：maxConcurrentTts=2 · 背压=暂停读 LLM · 打断=abort 全部流",
       font=f_small, fill=DIM)

img.save("E:/dp_work/desktop-companion/docs/assets/engine-v2.png")
print("ok", img.size)
