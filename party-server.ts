import type * as Party from "partykit/server";

// ── 타입 ──────────────────────────────────────────────────
interface Player {
  id: string;
  name: string;
  score: number;
  emoji: string;
  color: string;
  guessed: boolean;
  isDrawer: boolean;
}

interface GameState {
  phase: "lobby" | "playing" | "roundEnd" | "gameEnd";
  round: number;
  totalRounds: number;
  drawerIdx: number;
  wordKr: string;
  wordLen: number;   // 글자 수만 전달 (단어 자체는 그리는 사람에게만)
  wordNote: string;
  timerSec: number;
  players: Player[];
  usedWordIdxs: number[];
}

const EMOJIS = ["🐶","🐱","🦊","🐼","🐸"];
const COLORS = ["#e63946","#457b9d","#2a9d8f","#f4a261","#9b59b6"];

const WORDS = [
  { kr:"밥", note:"" }, { kr:"떡", note:"" }, { kr:"밤", note:"🌰 먹는 밤" },
  { kr:"배", note:"" }, { kr:"전", note:"" }, { kr:"곶감", note:"" },
  { kr:"닭고기", note:"" }, { kr:"사과", note:"" }, { kr:"생선", note:"" },
  { kr:"국수", note:"" }, { kr:"형", note:"" }, { kr:"동생", note:"" },
  { kr:"제비", note:"" }, { kr:"집", note:"" }, { kr:"둥지", note:"" },
  { kr:"지붕", note:"" }, { kr:"봄", note:"" }, { kr:"여름", note:"" },
  { kr:"가을", note:"" }, { kr:"겨울", note:"" }, { kr:"박", note:"" },
  { kr:"씨", note:"" }, { kr:"꽃", note:"" }, { kr:"그릇", note:"" },
  { kr:"책", note:"" }, { kr:"주걱", note:"" }, { kr:"이불", note:"" },
];

// ── 방 서버 ───────────────────────────────────────────────
export default class DrawServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  // 방 전체 상태
  state: GameState = {
    phase: "lobby",
    round: 1,
    totalRounds: 5,
    drawerIdx: 0,
    wordKr: "",
    wordLen: 0,
    wordNote: "",
    timerSec: 60,
    players: [],
    usedWordIdxs: [],
  };

  timerInterval: ReturnType<typeof setInterval> | null = null;

  // ── 연결 ────────────────────────────────────────────────
  onConnect(conn: Party.Connection) {
    // 새 연결에게 현재 상태 전송
    conn.send(JSON.stringify({ type: "state", state: this.safeState() }));
  }

  // ── 연결 끊김 ────────────────────────────────────────────
  onClose(conn: Party.Connection) {
    this.state.players = this.state.players.filter(p => p.id !== conn.id);
    // 그리는 사람이 나갔으면 다음 사람으로
    if (this.state.drawerIdx >= this.state.players.length) {
      this.state.drawerIdx = 0;
    }
    this.broadcast({ type: "state", state: this.safeState() });
    this.broadcast({ type: "chat", msg: "😢 플레이어가 나갔어요.", kind: "sys" });
  }

  // ── 메시지 ───────────────────────────────────────────────
  onMessage(message: string, sender: Party.Connection) {
    const data = JSON.parse(message);

    switch (data.type) {

      // 로비: 입장
      case "join": {
        const idx = this.state.players.length % 5;
        const player: Player = {
          id: sender.id,
          name: data.name || `플레이어${this.state.players.length + 1}`,
          score: 0,
          emoji: EMOJIS[idx],
          color: COLORS[idx],
          guessed: false,
          isDrawer: false,
        };
        this.state.players.push(player);
        this.broadcast({ type: "state", state: this.safeState() });
        this.broadcast({ type: "chat", msg: `👋 ${player.name}님이 입장했어요!`, kind: "sys" });
        break;
      }

      // 로비: 게임 시작 (방장만)
      case "startGame": {
        if (this.state.players.length < 2) break;
        this.state.phase = "playing";
        this.state.round = 1;
        this.state.usedWordIdxs = [];
        this.state.players.forEach(p => { p.score = 0; p.guessed = false; });
        this.pickWord();
        this.setDrawer(0);
        this.startTimer();
        this.broadcast({ type: "state", state: this.safeState() });
        this.broadcast({ type: "chat", msg: "🎮 게임 시작! 그림을 보고 한국어로 맞춰 보세요!", kind: "sys" });
        // 그리는 사람에게만 단어 전송
        this.sendWordToDrawer();
        break;
      }

      // 단어 건너뛰기 (그리는 사람만)
      case "skip": {
        const drawer = this.state.players[this.state.drawerIdx];
        if (drawer?.id !== sender.id) break;
        this.pickWord();
        this.broadcast({ type: "clearCanvas" });
        this.broadcast({ type: "state", state: this.safeState() });
        this.broadcast({ type: "chat", msg: "↻ 단어를 건너뛰었어요.", kind: "sys" });
        this.sendWordToDrawer();
        break;
      }

      // 정답 시도
      case "guess": {
        const player = this.state.players.find(p => p.id === sender.id);
        if (!player || player.isDrawer || player.guessed) break;
        const guess: string = data.text.trim();

        this.broadcast({ type: "chat", msg: guess, kind: "user", name: player.name });

        if (guess === this.state.wordKr) {
          player.guessed = true;
          const pts = Math.max(10, this.state.timerSec);
          player.score += pts;
          // 그린 사람도 소폭 점수
          const drawer = this.state.players[this.state.drawerIdx];
          if (drawer) drawer.score += 5;

          this.broadcast({ type: "chat", msg: `🎉 정답! +${pts}점`, kind: "ok", name: player.name });
          this.broadcast({ type: "correct", name: player.name });
          this.broadcast({ type: "state", state: this.safeState() });

          // 전원 맞췄으면 라운드 종료
          const guessers = this.state.players.filter(p => !p.isDrawer);
          if (guessers.every(p => p.guessed)) this.endRound();
        } else {
          this.broadcast({ type: "chat", msg: "❌ 아직 아니에요!", kind: "no", name: player.name });
        }
        break;
      }

      // 그림 데이터 (그리는 사람 → 나머지)
      case "draw": {
        const drawer = this.state.players[this.state.drawerIdx];
        if (drawer?.id !== sender.id) break;
        // 보낸 사람 빼고 전달
        this.room.broadcast(message, [sender.id]);
        break;
      }

      // 캔버스 지우기
      case "clearCanvas": {
        const drawer = this.state.players[this.state.drawerIdx];
        if (drawer?.id !== sender.id) break;
        this.broadcast({ type: "clearCanvas" });
        break;
      }

      // 다음 라운드
      case "nextRound": {
        this.nextRound();
        break;
      }

      // 다시 하기 (로비로)
      case "resetGame": {
        this.stopTimer();
        this.state.phase = "lobby";
        this.state.round = 1;
        this.state.usedWordIdxs = [];
        this.state.wordKr = "";
        this.state.players.forEach(p => { p.score = 0; p.guessed = false; p.isDrawer = false; });
        this.broadcast({ type: "state", state: this.safeState() });
        this.broadcast({ type: "chat", msg: "🔄 게임이 초기화됐어요!", kind: "sys" });
        break;
      }
    }
  }

  // ── 내부 헬퍼 ────────────────────────────────────────────

  pickWord() {
    const pool = WORDS.map((_,i) => i).filter(i => !this.state.usedWordIdxs.includes(i));
    const picked = pool.length
      ? pool[Math.floor(Math.random() * pool.length)]
      : (() => { this.state.usedWordIdxs = []; return Math.floor(Math.random() * WORDS.length); })();
    this.state.usedWordIdxs.push(picked);
    this.state.wordKr   = WORDS[picked].kr;
    this.state.wordNote = WORDS[picked].note;
    this.state.wordLen  = [...WORDS[picked].kr].length;
  }

  setDrawer(idx: number) {
    this.state.drawerIdx = idx;
    this.state.players.forEach((p, i) => {
      p.isDrawer = i === idx;
      p.guessed  = false;
    });
  }

  sendWordToDrawer() {
    const drawer = this.state.players[this.state.drawerIdx];
    if (!drawer) return;
    const conn = this.room.getConnection(drawer.id);
    conn?.send(JSON.stringify({
      type: "yourWord",
      wordKr:   this.state.wordKr,
      wordNote: this.state.wordNote,
    }));
  }

  startTimer() {
    this.state.timerSec = 60;
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      this.state.timerSec--;
      this.broadcast({ type: "tick", sec: this.state.timerSec });
      if (this.state.timerSec === 20) {
        this.broadcast({ type: "chat", msg: "⏰ 20초 남았어요!", kind: "sys" });
      }
      if (this.state.timerSec <= 0) this.endRound(true);
    }, 1000);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  endRound(timeout = false) {
    this.stopTimer();
    this.state.phase = "roundEnd";
    const msg = timeout
      ? `⏰ 시간 초과! 정답은 "${this.state.wordKr}" 이었어요.`
      : `✅ 라운드 종료! 정답: "${this.state.wordKr}"`;
    this.broadcast({ type: "roundEnd", word: this.state.wordKr, timeout });
    this.broadcast({ type: "chat", msg, kind: "sys" });
    this.broadcast({ type: "state", state: this.safeState() });
  }

  nextRound() {
    if (this.state.round >= this.state.totalRounds) {
      this.state.phase = "gameEnd";
      this.broadcast({ type: "gameEnd" });
      this.broadcast({ type: "state", state: this.safeState() });
      return;
    }
    this.state.round++;
    const nextDrawer = (this.state.drawerIdx + 1) % this.state.players.length;
    this.setDrawer(nextDrawer);
    this.pickWord();
    this.state.phase = "playing";
    this.broadcast({ type: "clearCanvas" });
    this.broadcast({ type: "state", state: this.safeState() });
    this.broadcast({ type: "chat",
      msg: `🎮 라운드 ${this.state.round} 시작!`, kind: "sys" });
    this.startTimer();
    this.sendWordToDrawer();
  }

  // state에서 wordKr 제외한 버전 (정답 숨김)
  safeState() {
    return { ...this.state, wordKr: "" };
  }

  broadcast(data: object) {
    this.room.broadcast(JSON.stringify(data));
  }
}
