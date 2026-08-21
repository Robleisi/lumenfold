/** 引导式新手教程：遮罩高亮 + 按步骤推进 */

const STEPS = [
  {
    id: "welcome",
    title: "欢迎来到折光织界",
    body: "这是一局「越打越爽」的折纸割草肉鸽。跟着光标走几步，就会折出第一道刃口。",
    spot: null,
    wait: "click",
  },
  {
    id: "move",
    title: "移动",
    body: "电脑用 WASD；手机在左半屏拖动即可移动。先随便走几步。",
    spot: "hint",
    wait: "move",
  },
  {
    id: "aim",
    title: "瞄准与普攻",
    body: "电脑：鼠标瞄准并按住左键。手机：在右半屏拖动瞄准开火。教程期间敌影不会还手，放心练手。",
    spot: "hint",
    wait: "shoot",
  },
  {
    id: "dash",
    title: "折冲",
    body: "电脑用右键或 Shift；手机点「折」按钮。向前撕开一道光带——既能躲弹，也能割伤路过的敌人。",
    spot: "hint",
    wait: "dash",
  },
  {
    id: "ult",
    title: "大招 · 墨能",
    body: "电脑按空格；手机点「墨」。消耗墨能清场，群怪堆在一起时甩一下最爽。",
    spot: "mp",
    wait: "ult",
  },
  {
    id: "pick",
    title: "折纹三选一",
    body: "清房后会弹出折纹。每一条都会改变你的手感——叠起来就是割草引擎。",
    spot: null,
    wait: "click",
  },
  {
    id: "meta",
    title: "越玩越多",
    body: "死后或通关获得折光尘，可在「织造工坊」永久解锁。折纹/遗物增强构筑；敌影/生态/守门会增加挑战（可在设置里关闭轮转）。",
    spot: null,
    wait: "click",
  },
];

export class Tutorial {
  constructor({ root, save, audio, onComplete }) {
    this.save = save;
    this.audio = audio;
    this.onComplete = onComplete;
    this.step = 0;
    this.active = false;
    this.flags = { moved: false, shot: false, dashed: false, ulted: false };

    this.el = document.createElement("div");
    this.el.id = "tutorial";
    this.el.className = "tutorial hidden";
    this.el.innerHTML = `
      <div class="tut-dim"></div>
      <div class="tut-spot" id="tut-spot"></div>
      <div class="tut-card" id="tut-card">
        <div class="tut-progress" id="tut-progress"></div>
        <h3 id="tut-title"></h3>
        <p id="tut-body"></p>
        <div class="tut-actions">
          <button class="btn" id="tut-skip">跳过教程</button>
          <button class="btn primary" id="tut-next">下一步</button>
        </div>
      </div>
    `;
    root.appendChild(this.el);

    this.els = {
      spot: this.el.querySelector("#tut-spot"),
      title: this.el.querySelector("#tut-title"),
      body: this.el.querySelector("#tut-body"),
      progress: this.el.querySelector("#tut-progress"),
      next: this.el.querySelector("#tut-next"),
      skip: this.el.querySelector("#tut-skip"),
    };

    this.els.next.onclick = () => this.advance(true);
    this.els.skip.onclick = () => this.finish(true);
  }

  shouldAutoStart() {
    return !this.save.tutorialDone;
  }

  start() {
    this.active = true;
    this.step = 0;
    this.flags = { moved: false, shot: false, dashed: false, ulted: false };
    this.el.classList.remove("hidden");
    this.render();
  }

  note(event) {
    if (!this.active) return;
    if (event === "move") this.flags.moved = true;
    if (event === "shoot") this.flags.shot = true;
    if (event === "dash") this.flags.dashed = true;
    if (event === "ult") this.flags.ulted = true;
    const cur = STEPS[this.step];
    if (!cur) return;
    if (cur.wait === "move" && this.flags.moved) this.advance(false);
    if (cur.wait === "shoot" && this.flags.shot) this.advance(false);
    if (cur.wait === "dash" && this.flags.dashed) this.advance(false);
    if (cur.wait === "ult" && this.flags.ulted) this.advance(false);
  }

  advance(fromClick) {
    const cur = STEPS[this.step];
    if (!cur) return;
    if (cur.wait !== "click" && fromClick) {
      // 允许手动跳过当前等待
    }
    this.audio?.ui?.();
    this.step++;
    if (this.step >= STEPS.length) {
      this.finish(false);
      return;
    }
    this.render();
  }

  async finish(skipped) {
    this.active = false;
    this.el.classList.add("hidden");
    this.save.tutorialDone = true;
    if (this.onComplete) await this.onComplete(skipped);
  }

  render() {
    const cur = STEPS[this.step];
    if (!cur) return;
    this.els.title.textContent = cur.title;
    this.els.body.textContent = cur.body;
    this.els.progress.textContent = `${this.step + 1} / ${STEPS.length}`;
    this.els.next.textContent = cur.wait === "click" ? (this.step === STEPS.length - 1 ? "开始割草" : "下一步") : "跳过此步";

    const spot = this.els.spot;
    spot.classList.add("hidden");
    if (cur.spot) {
      const target = cur.spot === "hint"
        ? document.getElementById("hint")
        : cur.spot === "mp"
          ? document.querySelector(".bar-wrap:last-child")
          : document.getElementById(cur.spot);
      if (target) {
        const r = target.getBoundingClientRect();
        spot.classList.remove("hidden");
        spot.style.left = `${r.left - 10}px`;
        spot.style.top = `${r.top - 10}px`;
        spot.style.width = `${r.width + 20}px`;
        spot.style.height = `${r.height + 20}px`;
      }
    }
  }
}

export { STEPS as TUTORIAL_STEPS };
