# -*- coding: utf-8 -*-
"""对话引擎 v2 的 UML 类图（Pillow 直绘）。列式布局，连线只出现在相邻列。"""

from PIL import Image, ImageDraw, ImageFont
import math

W, H = 2040, 1080
BG = (18, 18, 22)
PANEL = (27, 27, 32)
HEAD = (36, 36, 44)
LINE = (90, 87, 82)
TEXT = (233, 230, 225)
DIM = (156, 151, 143)
FAINT = (104, 100, 95)
ACCENT = (216, 185, 138)
GREEN = (127, 176, 105)
BLUE = (118, 164, 212)
PURPLE = (162, 142, 198)
RED = (216, 115, 92)


def F(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


FB = "C:/Windows/Fonts/msyhbd.ttc"
FR = "C:/Windows/Fonts/msyh.ttc"
FM = "C:/Windows/Fonts/consola.ttf"

f_title = F(FB, 28)
f_sub = F(FR, 15)
f_name = F(FB, 15)
f_stereo = F(FR, 12)
f_attr = F(FM, 12)
f_col = F(FB, 14)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

d.text((46, 26), "对话引擎 v2 · UML 类图", font=f_title, fill=TEXT)
d.text((46, 62), "箭头：──▷ 实现　──◆ 组合　┈┈▷ 依赖", font=f_sub, fill=DIM)

COLS = [
    (40, "渲染进程 Renderer", ACCENT),
    (440, "主进程 · 核心", ACCENT),
    (840, "适配器接口", ACCENT),
    (1240, "适配器实现", ACCENT),
    (1660, "配置与凭据", ACCENT),
]
for x, label, col in COLS:
    d.text((x + 4, 100), label, font=f_col, fill=col)


def uml(x, y, w, name, stereo="", attrs=(), ops=(), color=LINE, head=HEAD):
    """画一个 UML 类框，返回 (x, y, w, h)"""
    hh = 30 + (16 if stereo else 0)
    ah = 18 * len(attrs) + (8 if attrs else 0)
    oh = 18 * len(ops) + (8 if ops else 0)
    h = hh + ah + oh + 10

    d.rounded_rectangle([x, y, x + w, y + h], radius=6, fill=PANEL, outline=color)
    d.rounded_rectangle([x, y, x + w, y + hh], radius=6, fill=head, outline=color)
    d.rectangle([x, y + hh - 8, x + w, y + hh], fill=head)

    ty = y + 5
    if stereo:
        sw = d.textlength(stereo, font=f_stereo)
        d.text((x + w / 2 - sw / 2, ty), stereo, font=f_stereo, fill=DIM)
        ty += 16
    nw = d.textlength(name, font=f_name)
    d.text((x + w / 2 - nw / 2, ty), name, font=f_name, fill=TEXT)

    ly = y + hh
    if attrs:
        d.line([x, ly, x + w, ly], fill=color, width=1)
        ly += 6
        for a in attrs:
            d.text((x + 8, ly), a, font=f_attr, fill=DIM)
            ly += 18
        ly += 2
    if ops:
        d.line([x, ly, x + w, ly], fill=color, width=1)
        ly += 6
        for o in ops:
            d.text((x + 8, ly), o, font=f_attr, fill=TEXT)
            ly += 18
    return (x, y, w, h)


def path(points, color=LINE, dashed=False, width=1):
    for i in range(len(points) - 1):
        x1, y1 = points[i]
        x2, y2 = points[i + 1]
        if dashed:
            dist = math.hypot(x2 - x1, y2 - y1)
            steps = max(2, int(dist / 11))
            for k in range(steps):
                if k % 2:
                    continue
                a, b = k / steps, (k + 1) / steps
                d.line([x1 + (x2 - x1) * a, y1 + (y2 - y1) * a,
                        x1 + (x2 - x1) * b, y1 + (y2 - y1) * b], fill=color, width=width)
        else:
            d.line([x1, y1, x2, y2], fill=color, width=width)


def head_open(x, y, ang, color):
    for s in (0.42, -0.42):
        d.line([x, y, x - 11 * math.cos(ang - s), y - 11 * math.sin(ang - s)], fill=color, width=1)


def head_triangle(x, y, ang, color):
    p1 = (x, y)
    p2 = (x - 13 * math.cos(ang - 0.4), y - 13 * math.sin(ang - 0.4))
    p3 = (x - 13 * math.cos(ang + 0.4), y - 13 * math.sin(ang + 0.4))
    d.polygon([p1, p2, p3], fill=BG, outline=color)


def head_diamond(x, y, ang, color, size=9):
    cx = x - size * math.cos(ang)
    cy = y - size * math.sin(ang)
    p1 = (x, y)
    p2 = (cx + size * 0.6 * math.cos(ang + math.pi / 2), cy + size * 0.6 * math.sin(ang + math.pi / 2))
    p3 = (x - 2 * size * math.cos(ang), y - 2 * size * math.sin(ang))
    p4 = (cx - size * 0.6 * math.cos(ang + math.pi / 2), cy - size * 0.6 * math.sin(ang + math.pi / 2))
    d.polygon([p1, p2, p3, p4], fill=color, outline=color)


# ---------------- 第 1 列：渲染进程 ----------------
c_vc = uml(40, 140, 360, "VoiceCapture", "«component»",
           ["- stream: MediaStream", "- vadThreshold: number", "- pcmBuf: Int16Array"],
           ["+ start()", "+ onFrame(float32)", "+ commitSpeech() → PCM16"], BLUE)
c_ap = uml(40, 370, 360, "AudioPlayer", "«component»",
           ["- ctx: AudioContext", "- nextPlayAt: number", "- playingCount: number"],
           ["+ pushAudio(seq, pcm)", "+ advanceAudio()", "+ enqueuePcm(buf)"], GREEN)
c_vs = uml(40, 620, 360, "VideoSwitcher", "«component»",
           ["- activeVideo: 'vA'|'vB'", "- idleTimer: Timeout"],
           ["+ playStateVideo(state)", "+ swapVideo(url)"], PURPLE)

# ---------------- 第 2 列：核心 ----------------
c_tc = uml(440, 140, 360, "TurnController", "«service»",
           ["- currentTurnAbort: AbortController", "- history: Message[]"],
           ["+ chatTurnV2(text): TurnResult"], ACCENT)
c_eng = uml(440, 340, 360, "DialogueEngine", "«service»",
            ["- maxConcurrent = 2", "- seq: number", "- emotion: string"],
            ["+ runTurn(opts): TurnResult", "- enqueueSentence(s)", "- startTts(s, seq)"], ACCENT)
c_pool = uml(440, 610, 360, "TtsPool", "«utility»",
             ["- active: number", "- waiters: Promise[]"],
             ["+ acquire()", "+ release()"], ACCENT)
c_split = uml(440, 760, 360, "SentenceSplitter", "«utility»",
              ["- MARKS = '。！？；，、,.!?;'", "- maxLen = 24"],
              ["+ split(text, force): string[]", "+ speakable(text): string"], ACCENT)
c_bus = uml(440, 920, 360, "ReplyEventBus", "«channel»",
            ["- win: BrowserWindow"],
            ["+ send(type, payload)"], ACCENT)

# ---------------- 第 3 列：接口 ----------------
c_llm = uml(840, 160, 340, "LlmAdapter", "«interface»",
            [], ["+ stream(req): AsyncIterable<Delta>"], BLUE)
c_tts = uml(840, 330, 340, "TtsAdapter", "«interface»",
            ["+ caps: TtsCaps"],
            ["+ synth(req): AsyncIterable<Buffer>"], GREEN)
c_asr = uml(840, 520, 340, "AsrAdapter", "«interface»",
            [], ["+ transcribe(req): AsrResult"], BLUE)

# ---------------- 第 4 列：实现 ----------------
c_i1 = uml(1240, 150, 380, "OpenAiLlmAdapter", "«class»",
           ["- baseUrl, model, apiKey"],
           ["+ stream(req)"], BLUE)
c_i2 = uml(1240, 300, 380, "MimoTtsAdapter", "«class»",
           ["- voice, format='pcm16'"],
           ["+ synth(req)", "  SSE → delta.audio.data"], GREEN)
c_i3 = uml(1240, 450, 380, "DeepseekTtsAdapter", "«class»",
           ["- voiceId"],
           ["+ synth(req)", "  HTTP body → PCM 流"], GREEN)
c_i4 = uml(1240, 600, 380, "MimoAsrAdapter", "«class»",
           ["- language='zh'"],
           ["+ transcribe(req)", "  input_audio dataURL"], RED)
c_i5 = uml(1240, 750, 380, "DeepseekAsrAdapter", "«class»",
           ["- endpoint='/v1/tools/asr'"],
           ["+ transcribe(req)", "  multipart wav"], BLUE)

# ---------------- 第 5 列：配置 ----------------
c_cfg = uml(1660, 240, 340, "ProviderConfig", "«dataclass»",
            ["+ llm: {kind,baseUrl,model,keyRef}", "+ tts: {kind,voice,model,...}",
             "+ asr: {kind,language,...}"],
            ["+ defaults()"], ACCENT)
c_sec = uml(1660, 520, 340, "SecretStore", "«utility»",
            ["- ref: 'deepseek'|'mimo'"],
            ["+ getKey(ref): string|null", "+ setKey(ref, key)", "+ hasKey(ref): boolean"], ACCENT)

# ---------------- 关系 ----------------
# 实现（虚线 + 空心三角）
for impl, iface, y in [(c_i1, c_llm, 220), (c_i2, c_tts, 380), (c_i3, c_tts, 500),
                       (c_i4, c_asr, 640), (c_i5, c_asr, 800)]:
    x1 = impl[0]
    x2 = iface[0] + iface[2]
    path([(x1, y), (x2 + 14, y)], DIM, dashed=True)
    head_triangle(x2, y, math.pi, DIM)

# 组合：TurnController ◆— DialogueEngine
path([(c_tc[0] + 180, c_tc[1] + c_tc[3]), (c_tc[0] + 180, c_eng[1])], ACCENT, width=2)
head_diamond(c_tc[0] + 180, c_tc[1] + c_tc[3], -math.pi / 2, ACCENT)

# 组合：DialogueEngine ◆— TtsPool
path([(c_eng[0] + 180, c_eng[1] + c_eng[3]), (c_eng[0] + 180, c_pool[1])], ACCENT, width=2)
head_diamond(c_eng[0] + 180, c_eng[1] + c_eng[3], -math.pi / 2, ACCENT)

# 依赖：DialogueEngine ┈▷ SentenceSplitter
path([(c_eng[0] + 300, c_eng[1] + c_eng[3]), (c_eng[0] + 300, c_split[1])], DIM, dashed=True)
head_open(c_eng[0] + 300, c_split[1], -math.pi / 2, DIM)

# 依赖：DialogueEngine ┈▷ ReplyEventBus
path([(c_eng[0] + 60, c_eng[1] + c_eng[3]), (c_eng[0] + 60, c_bus[1])], DIM, dashed=True)
head_open(c_eng[0] + 60, c_bus[1], -math.pi / 2, DIM)

# 依赖：DialogueEngine ┈▷ LlmAdapter / TtsAdapter
path([(c_eng[0] + c_eng[2], 380), (c_llm[0], 380), (c_llm[0], c_llm[1] + c_llm[3] / 2)], DIM, dashed=True)
head_open(c_llm[0], c_llm[1] + c_llm[3] / 2, 0, DIM)
path([(c_eng[0] + c_eng[2], 470), (c_tts[0], 470)], DIM, dashed=True)
head_open(c_tts[0], 470, 0, DIM)

# 依赖：TurnController ┈▷ SecretStore / ProviderConfig（走顶部走廊）
path([(c_tc[0] + 300, c_tc[1]), (c_tc[0] + 300, 120), (1500, 120), (1500, c_cfg[1] + 60), (c_cfg[0], c_cfg[1] + 60)],
     DIM, dashed=True)
head_open(c_cfg[0], c_cfg[1] + 60, 0, DIM)

# 依赖：ReplyEventBus ┈▷ AudioPlayer（事件投递）
path([(c_bus[0], 960), (400 - 40, 960), (400 - 40, 470), (c_ap[0] + c_ap[2], 470)], DIM, dashed=True)
head_open(c_ap[0] + c_ap[2], 470, math.pi, DIM)

# 依赖：AudioPlayer ┈▷ VideoSwitcher
path([(c_ap[0] + 180, c_ap[1] + c_ap[3]), (c_ap[0] + 180, c_vs[1])], DIM, dashed=True)
head_open(c_ap[0] + 180, c_vs[1], -math.pi / 2, DIM)

# 依赖：VoiceCapture ┈▷ AsrAdapter（跨 IPC，走顶部走廊）
path([(c_vc[0] + 180, c_vc[1]), (c_vc[0] + 180, 130), (1010, 130), (1010, c_asr[1])], DIM, dashed=True)
head_open(1010, c_asr[1], -math.pi / 2, DIM)

d.text((46, H - 40), "说明：渲染进程与主进程之间只有 IPC 事件（audio{seq}、audio-end、first-token…），没有共享内存。"
                     "适配器全部实现同一组接口，所以换供应商只需改 ProviderConfig。",
       font=f_sub, fill=FAINT)

img.save("E:/dp_work/desktop-companion/docs/assets/engine-v2-uml.png")
print("ok", img.size)
