/** 移动端双摇杆：左半屏移动、右半屏瞄准开火，外加折冲 / 大招 / 暂停 */

import { t } from "./i18n.js";

const DEAD = 0.16;

export function preferTouchUi() {
  try {
    if (window.matchMedia("(pointer: coarse)").matches) return true;
    if (window.matchMedia("(hover: none)").matches && navigator.maxTouchPoints > 0) return true;
  } catch { /* */ }
  return navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) <= 920;
}

export class TouchControls {
  /**
   * @param {{ root: HTMLElement, onPause?: () => void }} opts
   */
  constructor({ root, onPause }) {
    this.onPause = onPause;
    this.enabled = false;
    this.hudOpen = false;
    this.blocked = false;

    this.moveX = 0;
    this.moveY = 0;
    this.aimX = 0;
    this.aimY = 0;
    this.aiming = false;
    this.fire = false;
    this.dashHeld = false;
    this.ultHeld = false;

    this._movePtr = null;
    this._aimPtr = null;
    this._moveOrigin = null;
    this._aimOrigin = null;
    this._armedOnce = null;

    this.el = document.createElement("div");
    this.el.id = "touch-controls";
    this.el.className = "hidden";
    this.el.innerHTML = `
      <button type="button" class="touch-pause" id="touch-pause" aria-label="暂停">暂停</button>
      <div class="touch-zone touch-zone-move" id="touch-zone-move" aria-hidden="true"></div>
      <div class="touch-zone touch-zone-aim" id="touch-zone-aim" aria-hidden="true"></div>
      <div class="touch-pad touch-move" id="touch-move" aria-label="移动">
        <div class="touch-ring"></div>
        <div class="touch-knob" id="touch-move-knob"></div>
        <span class="touch-label">移</span>
      </div>
      <div class="touch-pad touch-aim" id="touch-aim" aria-label="瞄准开火">
        <div class="touch-ring"></div>
        <div class="touch-knob" id="touch-aim-knob"></div>
        <span class="touch-label">射</span>
      </div>
      <button type="button" class="touch-act touch-act-dash primary" id="touch-dash" aria-label="折冲">折</button>
      <button type="button" class="touch-act touch-act-ult" id="touch-ult" aria-label="大招">墨</button>
    `;
    root.appendChild(this.el);

    this.moveZone = this.el.querySelector("#touch-zone-move");
    this.aimZone = this.el.querySelector("#touch-zone-aim");
    this.movePad = this.el.querySelector("#touch-move");
    this.aimPad = this.el.querySelector("#touch-aim");
    this.moveKnob = this.el.querySelector("#touch-move-knob");
    this.aimKnob = this.el.querySelector("#touch-aim-knob");
    this.btnDash = this.el.querySelector("#touch-dash");
    this.btnUlt = this.el.querySelector("#touch-ult");
    this.btnPause = this.el.querySelector("#touch-pause");

    this._bindZone(this.moveZone, "move");
    this._bindZone(this.aimZone, "aim");
    this._bindAct(this.btnDash, "dash");
    this._bindAct(this.btnUlt, "ult");
    this.btnPause.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onPause?.();
    });

    this._armedOnce = () => this.arm();
    window.addEventListener("touchstart", this._armedOnce, { passive: true });
  }

  arm() {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add("touch-ui");
    const hint = document.getElementById("hint");
    if (hint) hint.textContent = t("hint_touch");
    if (this.btnPause) this.btnPause.textContent = t("btn_pause_short");
    this._syncVisibility();
    if (this._armedOnce) {
      window.removeEventListener("touchstart", this._armedOnce);
      this._armedOnce = null;
    }
  }

  /** 开局时：粗指针设备直接启用 */
  preferArm() {
    if (preferTouchUi()) this.arm();
  }

  setHudOpen(open) {
    this.hudOpen = !!open;
    this._syncVisibility();
  }

  /** 选折纹 / 暂停等遮罩期间禁用摇杆，避免挡按钮 */
  setBlocked(blocked) {
    this.blocked = !!blocked;
    if (blocked) this.resetAxes();
    this._syncVisibility();
  }

  _syncVisibility() {
    const show = this.enabled && this.hudOpen && !this.blocked;
    this.el.classList.toggle("hidden", !show);
  }

  resetAxes() {
    this.moveX = this.moveY = 0;
    this.aimX = this.aimY = 0;
    this.aiming = false;
    this.fire = false;
    this.dashHeld = false;
    this.ultHeld = false;
    this._movePtr = null;
    this._aimPtr = null;
    this._moveOrigin = null;
    this._aimOrigin = null;
    this._setKnob(this.moveKnob, 0, 0);
    this._setKnob(this.aimKnob, 0, 0);
    this._parkPad(this.movePad, "move");
    this._parkPad(this.aimPad, "aim");
    this.movePad?.classList.remove("active");
    this.aimPad?.classList.remove("active");
    this.btnDash?.classList.remove("held");
    this.btnUlt?.classList.remove("held");
  }

  _parkPad(pad, which) {
    if (!pad) return;
    pad.style.left = "";
    pad.style.right = "";
    pad.style.top = "";
    pad.style.bottom = "";
    pad.classList.toggle("floating", false);
  }

  _placePad(pad, which, clientX, clientY) {
    if (!pad) return;
    const size = Math.min(pad.offsetWidth || 140, pad.offsetHeight || 140);
    const half = size * 0.5;
    const margin = 8;
    const x = Math.max(margin + half, Math.min(window.innerWidth - margin - half, clientX));
    const y = Math.max(margin + half, Math.min(window.innerHeight - margin - half, clientY));
    pad.classList.add("floating");
    pad.style.left = `${x - half}px`;
    pad.style.top = `${y - half}px`;
    pad.style.right = "auto";
    pad.style.bottom = "auto";
    return { x, y, max: half * 0.78 };
  }

  _bindZone(el, which) {
    if (!el) return;
    const onDown = (e) => {
      if (!this.enabled || this.blocked) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      // 避免同一侧被两个元素重复捕获
      if (which === "move" && this._movePtr != null) return;
      if (which === "aim" && this._aimPtr != null) return;
      e.preventDefault();
      e.stopPropagation();
      this.arm();
      try { el.setPointerCapture?.(e.pointerId); } catch { /* 合成事件或不支持时忽略 */ }
      const origin = this._placePad(which === "move" ? this.movePad : this.aimPad, which, e.clientX, e.clientY);
      if (which === "move") {
        this._movePtr = e.pointerId;
        this._moveOrigin = origin;
        this.movePad.classList.add("active");
      } else {
        this._aimPtr = e.pointerId;
        this._aimOrigin = origin;
        this.aimPad.classList.add("active");
      }
      this._updateFromOrigin(which, e.clientX, e.clientY);
    };
    const onMove = (e) => {
      const id = which === "move" ? this._movePtr : this._aimPtr;
      if (id !== e.pointerId) return;
      e.preventDefault();
      this._updateFromOrigin(which, e.clientX, e.clientY);
    };
    const onUp = (e) => {
      const id = which === "move" ? this._movePtr : this._aimPtr;
      if (id !== e.pointerId) return;
      e.preventDefault();
      try { el.releasePointerCapture?.(e.pointerId); } catch { /* */ }
      if (which === "move") {
        this._movePtr = null;
        this._moveOrigin = null;
        this.moveX = this.moveY = 0;
        this._setKnob(this.moveKnob, 0, 0);
        this.movePad.classList.remove("active");
        this._parkPad(this.movePad, "move");
      } else {
        this._aimPtr = null;
        this._aimOrigin = null;
        this.aimX = this.aimY = 0;
        this.aiming = false;
        this.fire = false;
        this._setKnob(this.aimKnob, 0, 0);
        this.aimPad.classList.remove("active");
        this._parkPad(this.aimPad, "aim");
      }
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  _bindAct(btn, which) {
    const down = (e) => {
      if (!this.enabled || this.blocked) return;
      e.preventDefault();
      e.stopPropagation();
      this.arm();
      try { btn.setPointerCapture?.(e.pointerId); } catch { /* */ }
      btn.classList.add("held");
      if (which === "dash") this.dashHeld = true;
      else this.ultHeld = true;
    };
    const up = (e) => {
      e.preventDefault();
      try { btn.releasePointerCapture?.(e.pointerId); } catch { /* */ }
      btn.classList.remove("held");
      if (which === "dash") this.dashHeld = false;
      else this.ultHeld = false;
    };
    btn.addEventListener("pointerdown", down);
    btn.addEventListener("pointerup", up);
    btn.addEventListener("pointercancel", up);
    btn.addEventListener("pointerleave", (e) => {
      if (btn.classList.contains("held")) up(e);
    });
  }

  _updateFromOrigin(which, clientX, clientY) {
    const origin = which === "move" ? this._moveOrigin : this._aimOrigin;
    if (!origin) return;
    let dx = clientX - origin.x;
    let dy = clientY - origin.y;
    const len = Math.hypot(dx, dy) || 1;
    const max = origin.max || 48;
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    const nx = dx / max;
    const ny = dy / max;
    const mag = Math.hypot(nx, ny);
    const live = mag >= DEAD;
    const sx = live ? nx : 0;
    const sy = live ? ny : 0;

    if (which === "move") {
      this.moveX = sx;
      this.moveY = sy;
      this._setKnob(this.moveKnob, dx, dy);
    } else {
      this.aimX = sx;
      this.aimY = sy;
      this.aiming = live;
      this.fire = live;
      this._setKnob(this.aimKnob, dx, dy);
    }
  }

  _setKnob(knob, dx, dy) {
    if (!knob) return;
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
