// ---- Visual design tokens ----
const COL_BG = '#14171C';
const COL_PANEL = '#1C212B';
const COL_BORDER = '#2E3542';
const COL_GRID = '#242A35';
const COL_TEXT = '#EDEAE3';
const COL_MUTED = '#8891A3';
const COL_CORAL = '#FF6B7A';   // game / snake / food
const COL_CYAN = '#4FD9E8';    // hand-tracking / HUD
const COL_AMBER = '#F5B44D';   // "building up" state
const FONT_DISPLAY = 'Space Grotesk, sans-serif';
const FONT_MONO = 'IBM Plex Mono, monospace';

// ---- Game state ----
let snake;
let rez = 20;
let food;
let w;
let h;
const GAME_W = 400;
const GAME_H = 400;

// ---- Hand-joystick state ----
let video;
let handPose;
let hands = [];
let modelReady = false;

const VIDEO_W = 320;
const VIDEO_H = 240;
const PANEL_X = GAME_W + 20; // video panel sits to the right of the game
const PANEL_Y = 60;

// Minimum length (in pixels) the wrist->middle-finger vector must have
// before we trust its angle. Too short usually means the hand is angled
// toward/away from the camera or fingers are curled, so the direction
// would be noisy.
const MIN_POINT_LEN = 40;

// Smoothing factor for the tracked wrist point (0 = no smoothing/very jittery,
// 1 = frozen/unresponsive). Lower this if it still feels twitchy, raise it
// if it feels laggy.
const SMOOTHING = 0.35;

// Minimum overall hand-detection confidence to trust it at all (0-1)
const MIN_CONFIDENCE = 0.6;

// A direction has to be seen for several consecutive frames before
// it's actually applied, to filter out single-frame tracking glitches.
// Lowered from 3 -> 2 now that draw() runs at 30fps instead of 10fps, so
// this still represents a real glitch filter without feeling laggy.
const HOLD_FRAMES = 2;

// Extra angular margin (radians) added to the CURRENTLY committed
// direction's 90-degree quadrant before we'll let it switch away. This is
// what actually removes the flicker/jitter you get right at a quadrant
// boundary (e.g. hand angle hovering between RIGHT and UP) -- without it,
// a tiny tremor right on the line rapidly toggles the candidate direction.
// ~0.175 rad ~= 10 degrees of "stickiness". Raise for more stability,
// lower if turning starts to feel delayed.
const HYSTERESIS_MARGIN = 0.175;

// ---- Snake move timing (decoupled from frameRate) ----
// draw() now runs fast (30fps) purely so hand tracking stays smooth/responsive.
// The snake itself advances on its own timer below, independent of draw's rate.
let moveInterval = 150; // ms between snake steps; lower = faster snake
let lastMoveTime = 0;

// Optional progressive difficulty: shrink moveInterval each time the snake
// eats, down to a floor, so the game speeds up as the score climbs.
const SPEED_UP_PER_FOOD = 4; // ms shaved off moveInterval per food eaten
const MIN_MOVE_INTERVAL = 60; // fastest the snake is allowed to go

let currentDir = 'RIGHT'; // human-readable label of last applied direction
let handStatus = 'Searching for hand...';
let smoothVx = 1; // smoothed wrist->middle-finger pointing vector (screen space)
let smoothVy = 0;
let candidateDir = null;
let candidateCount = 0;

// Center angle (radians, screen space: +x=right, +y=down) of each direction's
// quadrant, used for the hysteresis check below. NOTE: uses Math.PI directly
// (not p5's HALF_PI/PI) because this runs at script-parse time, before p5
// has attached its constants to window -- using the p5 constants here would
// throw "HALF_PI is not defined" and silently break the whole sketch.
const DIR_ANGLES = { RIGHT: 0, DOWN: Math.PI / 2, LEFT: Math.PI, UP: -Math.PI / 2 };

// Shortest signed distance between two angles, wrapped to [-PI, PI], then
// made absolute -- used to test "how far is this angle from that direction's center".
function angularDist(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

// Finger chains for drawing the hand skeleton (by keypoint name)
const FINGER_CHAINS = [
  ['wrist', 'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip'],
  ['wrist', 'index_finger_mcp', 'index_finger_pip', 'index_finger_dip', 'index_finger_tip'],
  ['wrist', 'middle_finger_mcp', 'middle_finger_pip', 'middle_finger_dip', 'middle_finger_tip'],
  ['wrist', 'ring_finger_mcp', 'ring_finger_pip', 'ring_finger_dip', 'ring_finger_tip'],
  ['wrist', 'pinky_finger_mcp', 'pinky_finger_pip', 'pinky_finger_dip', 'pinky_finger_tip']
];

// ---- Game / app state machine ----
// 'CALIBRATE' -> practice steering without the snake moving
// 'PLAYING'   -> normal gameplay
// 'GAMEOVER'  -> snake died, show score + restart
let gameState = 'CALIBRATE';

let startButton;
let restartButton;

function setup() {
  let cnv = createCanvas(PANEL_X + VIDEO_W + 20, GAME_H + 100);
  cnv.parent('canvas-holder');
  textFont(FONT_MONO);

  w = floor(GAME_W / rez);
  h = floor(GAME_H / rez);
  // Run draw() at a much higher, steady rate than the old 10fps. Hand
  // tracking now samples every frame, so it stays smooth and responsive;
  // snake movement is paced separately below via moveInterval, so this
  // does NOT make the snake itself faster.
  frameRate(30);
  snake = new Snake();
  foodLocation();

  // Webcam capture for HandPose
  video = createCapture(VIDEO);
  video.size(VIDEO_W, VIDEO_H);
  video.hide();

  // flipped: true tells handPose to return keypoint coordinates already
  // matching a mirrored ("selfie") view, since we draw the video mirrored
  // ourselves below (this p5 version doesn't support video.flipped).
  // detectStart must only be called once the model is actually ready --
  // calling it immediately after construction races the async model load
  // and crashes with "Cannot read properties of null (reading 'estimateHands')".
  handPose = ml5.handPose({ flipped: true, maxHands: 1 }, () => {
    modelReady = true;
    select('#status').html('HandPose ready — show your hand to the camera.');
    handPose.detectStart(video, (results) => {
      hands = results || [];
    });
  });

  startButton = createButton('Start Game');
  startButton.position(PANEL_X, PANEL_Y + VIDEO_H + 55);
  startButton.mousePressed(startGame);

  restartButton = createButton('Restart');
  restartButton.position(GAME_W / 2 - 30, 40 + GAME_H / 2 + 55);
  restartButton.mousePressed(restartGame);
  restartButton.hide();
}

function foodLocation() {
  let x = floor(random(w));
  let y = floor(random(h));
  food = createVector(x, y);
}

function startGame() {
  gameState = 'PLAYING';
  lastMoveTime = millis();
  startButton.hide();
  loop();
}

function restartGame() {
  snake = new Snake();
  foodLocation();
  candidateDir = null;
  candidateCount = 0;
  currentDir = 'RIGHT';
  moveInterval = 150;
  lastMoveTime = millis();
  gameState = 'PLAYING';
  restartButton.hide();
  loop();
}

// ---- Keyboard fallback (still works alongside hand control) ----
function keyPressed() {
  if (gameState === 'CALIBRATE' && keyCode === ENTER) {
    startGame();
    return;
  }
  if (gameState === 'GAMEOVER' && (key === 'r' || key === 'R')) {
    restartGame();
    return;
  }
  if (gameState !== 'PLAYING') return;

  if (keyCode === LEFT_ARROW) {
    trySetDir(-1, 0, 'LEFT');
  } else if (keyCode === RIGHT_ARROW) {
    trySetDir(1, 0, 'RIGHT');
  } else if (keyCode === DOWN_ARROW) {
    trySetDir(0, 1, 'DOWN');
  } else if (keyCode === UP_ARROW) {
    trySetDir(0, -1, 'UP');
  } else if (key === ' ') {
    snake.grow();
  }
}

// Prevents reversing straight into your own body (important since hand
// control is less precise than keys, this avoids cheap accidental deaths)
function trySetDir(x, y, label) {
  if (snake.xdir === -x && snake.ydir === -y && (snake.xdir !== 0 || snake.ydir !== 0)) {
    return; // ignore 180-degree reversal
  }
  snake.setDir(x, y);
  currentDir = label;
}

// Returns the most confident detected hand, or null if none pass the
// confidence threshold. Unlike the old PoseNet approach, handPose only
// ever reports actual hands — there's no elbow/background confusion to
// filter out, since the model is purpose-built for hands.
function getValidHand() {
  if (!hands || hands.length === 0) return null;
  let best = null;
  for (const hnd of hands) {
    if (hnd.confidence < MIN_CONFIDENCE) continue;
    if (!best || hnd.confidence > best.confidence) best = hnd;
  }
  return best;
}

// ---- Hand-angle joystick logic ----
// Instead of asking "where is my hand in the frame", this asks "which way
// is my hand pointing". We take the vector from the wrist to the middle
// finger's base knuckle (stable even with fingers curled a bit) and read
// its angle: point right/left/up/down and the snake follows. The vector
// is smoothed component-wise (not the angle directly, which would need
// wraparound handling), then bucketed into a 90-degree quadrant per
// direction. A direction must hold for HOLD_FRAMES in a row to commit,
// same glitch filtering as before.
function updateDirectionFromHand() {
  let hand = getValidHand();

  if (!hand) {
    handStatus = hands && hands.length > 0 ? 'Hand detected but low confidence' : 'No hand detected';
    candidateDir = null;
    candidateCount = 0;
    return;
  }

  let wrist = hand.keypoints.find(k => k.name === 'wrist');
  let midMcp = hand.keypoints.find(k => k.name === 'middle_finger_mcp');
  if (!wrist || !midMcp) {
    handStatus = 'No hand detected';
    candidateDir = null;
    candidateCount = 0;
    return;
  }

  handStatus = 'Tracking ' + hand.handedness + ' hand (' + nf(hand.confidence, 1, 2) + ')';

  // Raw pointing vector: wrist -> middle finger knuckle
  let rawVx = midMcp.x - wrist.x;
  let rawVy = midMcp.y - wrist.y;
  let len = Math.hypot(rawVx, rawVy);

  // Too short to read an angle reliably (hand facing camera, fist, etc.)
  if (len < MIN_POINT_LEN) {
    handStatus += ' — point more clearly (hand too flat/curled)';
    candidateDir = null;
    candidateCount = 0;
    return;
  }

  // Normalize before smoothing so vector length doesn't bias the smoothed angle
  rawVx /= len;
  rawVy /= len;

  // Exponential smoothing on the vector components (avoids angle wraparound issues)
  smoothVx = lerp(smoothVx, rawVx, 1 - SMOOTHING);
  smoothVy = lerp(smoothVy, rawVy, 1 - SMOOTHING);

  // atan2 gives angle in screen space where +x = right, +y = down
  let angle = Math.atan2(smoothVy, smoothVx); // range -PI..PI

  // Bucket into 90-degree quadrants centered on each cardinal direction.
  // Hysteresis: if the angle is still within the CURRENT direction's
  // quadrant plus a small extra margin, stick with it instead of switching
  // -- this is what kills the flicker right at a quadrant boundary.
  let newCandidate;
  if (currentDir && angularDist(angle, DIR_ANGLES[currentDir]) <= QUARTER_PI + HYSTERESIS_MARGIN) {
    newCandidate = currentDir;
  } else if (angle > -QUARTER_PI && angle <= QUARTER_PI) {
    newCandidate = 'RIGHT';
  } else if (angle > QUARTER_PI && angle <= 3 * QUARTER_PI) {
    newCandidate = 'DOWN';
  } else if (angle < -QUARTER_PI && angle >= -3 * QUARTER_PI) {
    newCandidate = 'UP';
  } else {
    newCandidate = 'LEFT';
  }

  if (newCandidate === candidateDir) {
    candidateCount++;
  } else {
    candidateDir = newCandidate;
    candidateCount = 1;
  }

  // Only commit once the same direction has been seen for HOLD_FRAMES in a row
  if (candidateCount >= HOLD_FRAMES) {
    if (newCandidate === 'RIGHT') trySetDir(1, 0, 'RIGHT');
    else if (newCandidate === 'LEFT') trySetDir(-1, 0, 'LEFT');
    else if (newCandidate === 'DOWN') trySetDir(0, 1, 'DOWN');
    else if (newCandidate === 'UP') trySetDir(0, -1, 'UP');
  }
}

function draw() {
  background(COL_BG);

  updateDirectionFromHand();

  drawHeader();

  if (gameState === 'CALIBRATE') {
    drawCalibrationScreen();
  } else if (gameState === 'PLAYING') {
    drawGame();
  } else if (gameState === 'GAMEOVER') {
    drawGame();
    drawGameOverOverlay();
  }

  drawHandPanel();
}

// A small pill-shaped HUD readout: a muted label above a bold value,
// used for score/direction/speed so the header reads like instrument data
// rather than plain debug text.
function drawReadout(x, y, w, label, value, accent) {
  push();
  translate(x, y);
  noStroke();
  fill(COL_PANEL);
  stroke(COL_BORDER);
  strokeWeight(1);
  rect(0, 0, w, 34, 8);

  noStroke();
  fill(COL_MUTED);
  textFont(FONT_MONO);
  textSize(9);
  textAlign(LEFT, TOP);
  text(label, 10, 6);

  fill(accent || COL_TEXT);
  textFont(FONT_DISPLAY);
  textSize(14);
  textAlign(LEFT, TOP);
  text(value, 10, 16);
  pop();
}

function drawHeader() {
  drawReadout(10, 6, 110, 'SCORE', String(snake.len), COL_TEXT);
  drawReadout(128, 6, 130, 'DIRECTION', currentDir, COL_CORAL);
  drawReadout(266, 6, 134, 'SPEED', moveInterval + ' ms/step', COL_CYAN);
}

function drawGame() {
  push();
  translate(0, 40);
  fill(COL_PANEL);
  stroke(COL_BORDER);
  strokeWeight(1);
  rect(0, 0, GAME_W, GAME_H, 10);

  // Graph-paper grid, subtle -- reinforces the "board" reading of the play area
  stroke(COL_GRID);
  strokeWeight(1);
  for (let gx = rez; gx < GAME_W; gx += rez) line(gx, 1, gx, GAME_H - 1);
  for (let gy = rez; gy < GAME_H; gy += rez) line(1, gy, GAME_W - 1, gy);

  push();
  scale(rez);
  if (gameState === 'PLAYING' && millis() - lastMoveTime > moveInterval) {
    lastMoveTime = millis();
    if (snake.eat(food)) {
      foodLocation();
      moveInterval = max(MIN_MOVE_INTERVAL, moveInterval - SPEED_UP_PER_FOOD);
    }
    snake.update();
  }
  snake.show();
  noStroke();
  // Food: soft coral glow that gently pulses, drawn under the solid dot
  let pulse = 0.55 + 0.25 * sin(frameCount * 0.15);
  fill(red(color(COL_CORAL)), green(color(COL_CORAL)), blue(color(COL_CORAL)), 70 * pulse);
  ellipse(food.x + 0.5, food.y + 0.5, 2.1, 2.1);
  fill(COL_CORAL);
  rect(food.x, food.y, 1, 1, 0.2);
  pop();

  if (gameState === 'PLAYING' && snake.endGame()) {
    gameState = 'GAMEOVER';
    restartButton.show();
  }
  pop();
}

function drawGameOverOverlay() {
  push();
  translate(0, 40);
  noStroke();
  fill(20, 22, 28, 225);
  rect(0, 0, GAME_W, GAME_H, 10);

  fill(COL_CORAL);
  textFont(FONT_DISPLAY);
  textAlign(CENTER, CENTER);
  textSize(13);
  text('GAME OVER', GAME_W / 2, GAME_H / 2 - 34);

  fill(COL_TEXT);
  textSize(40);
  text(snake.len, GAME_W / 2, GAME_H / 2 - 2);

  fill(COL_MUTED);
  textFont(FONT_MONO);
  textSize(11);
  text('FINAL SCORE', GAME_W / 2, GAME_H / 2 + 28);

  fill(COL_CYAN);
  textSize(11);
  text('Press R or click Restart', GAME_W / 2, GAME_H / 2 + 54);
  pop();
}

function drawCalibrationScreen() {
  push();
  translate(0, 40);
  fill(COL_PANEL);
  stroke(COL_BORDER);
  strokeWeight(1);
  rect(0, 0, GAME_W, GAME_H, 10);

  noStroke();
  fill(COL_CYAN);
  textFont(FONT_MONO);
  textAlign(CENTER, CENTER);
  textSize(10);
  text('STEERING TEST', GAME_W / 2, 36);

  fill(COL_MUTED);
  textSize(11);
  text('Point your hand (fingers extended) in a direction\nin the camera panel to steer.', GAME_W / 2, 62);

  // Big directional readout so you can confirm tracking works before playing
  fill(COL_TEXT);
  textFont(FONT_DISPLAY);
  textSize(42);
  let label = candidateDir || '·';
  text(label, GAME_W / 2, GAME_H / 2);

  fill(COL_MUTED);
  textFont(FONT_MONO);
  textSize(11);
  text('Press ENTER or click "Start Game" when ready', GAME_W / 2, GAME_H - 34);
  pop();
}

// Draws the 21-point hand skeleton (finger by finger) for whichever hand is
// currently being used to steer, in green. This is the debug view for
// confirming HandPose is actually tracking your hand and not something else.
function drawHandSkeleton(hand, isActive) {
  const kp = (name) => hand.keypoints.find(k => k.name === name);

  stroke(isActive ? color(COL_CYAN) : color(140, 148, 163, 90));
  strokeWeight(isActive ? 2.5 : 1);
  for (const chain of FINGER_CHAINS) {
    for (let i = 0; i < chain.length - 1; i++) {
      let a = kp(chain[i]);
      let b = kp(chain[i + 1]);
      if (a && b) line(a.x, a.y, b.x, b.y);
    }
  }

  noStroke();
  fill(isActive ? color(COL_CYAN) : color(140, 148, 163, 150));
  for (const k of hand.keypoints) {
    ellipse(k.x, k.y, 5, 5);
  }
}

// Small L-shaped bracket, like a camera viewfinder corner. dx/dy pick which
// corner (±1) so the same call works for all four.
function corner(x, y, dx, dy, len) {
  line(x, y, x + dx * len, y);
  line(x, y, x, y + dy * len);
}

function drawHandPanel() {
  push();
  translate(PANEL_X, PANEL_Y);

  // Panel backing + viewfinder frame
  noStroke();
  fill(COL_PANEL);
  rect(-10, -10, VIDEO_W + 20, VIDEO_H + 60, 10);
  stroke(COL_BORDER);
  strokeWeight(1);
  noFill();
  rect(0, 0, VIDEO_W, VIDEO_H, 4);

  // Video feed (mirrored; handPose was set up with flipped:true to match)
  if (video) {
    push();
    translate(VIDEO_W, 0);
    scale(-1, 1);
    image(video, 0, 0, VIDEO_W, VIDEO_H);
    pop();
  }

  // Hand skeleton debug overlay
  if (hands && hands.length > 0) {
    let active = getValidHand();
    for (const hnd of hands) {
      drawHandSkeleton(hnd, hnd === active);
    }
  }

  // Cyan quadrant guides -- faint reference lines for where the four
  // direction buckets (RIGHT/DOWN/LEFT/UP) split
  stroke(79, 217, 232, 70);
  strokeWeight(1);
  let cx = VIDEO_W / 2;
  let cy = VIDEO_H / 2;
  let guideLen = 70;
  line(cx - guideLen * cos(QUARTER_PI), cy - guideLen * sin(QUARTER_PI), cx + guideLen * cos(QUARTER_PI), cy + guideLen * sin(QUARTER_PI));
  line(cx - guideLen * cos(QUARTER_PI), cy + guideLen * sin(QUARTER_PI), cx + guideLen * cos(QUARTER_PI), cy - guideLen * sin(QUARTER_PI));

  // Pointing-direction arrow + rotating "lock-on" ring around the wrist --
  // this is the signature moment: it reads as a tracking-lock indicator,
  // like a computer-vision demo confirming what it's watching.
  if (handStatus.startsWith('Tracking')) {
    let active = getValidHand();
    let wrist = active && active.keypoints.find(k => k.name === 'wrist');
    if (wrist) {
      let locked = candidateCount >= HOLD_FRAMES;
      let col = locked ? color(COL_CYAN) : color(COL_AMBER);

      // Rotating dashed ring, slow when idle, so the panel always feels alive
      push();
      translate(wrist.x, wrist.y);
      rotate(frameCount * 0.02);
      stroke(col);
      strokeWeight(1.5);
      noFill();
      let segs = 10;
      for (let i = 0; i < segs; i++) {
        let a0 = (TWO_PI / segs) * i;
        let a1 = a0 + (TWO_PI / segs) * 0.55;
        arc(0, 0, 34, 34, a0, a1);
      }
      pop();

      // Direction arrow
      let arrowLen = 60;
      let tipX = wrist.x + smoothVx * arrowLen;
      let tipY = wrist.y + smoothVy * arrowLen;
      stroke(col);
      strokeWeight(3);
      line(wrist.x, wrist.y, tipX, tipY);
      noStroke();
      fill(col);
      ellipse(tipX, tipY, 10, 10);
    }
  }

  // Viewfinder corner brackets, drawn last so they sit above the video
  stroke(COL_CYAN);
  strokeWeight(2);
  let bl = 16;
  corner(0, 0, 1, 1, bl);
  corner(VIDEO_W, 0, -1, 1, bl);
  corner(0, VIDEO_H, 1, -1, bl);
  corner(VIDEO_W, VIDEO_H, -1, -1, bl);

  pop();

  // Status readout below the video panel
  push();
  translate(PANEL_X, PANEL_Y + VIDEO_H + 14);
  noStroke();
  fill(handStatus.startsWith('Tracking') ? COL_CYAN : COL_MUTED);
  textFont(FONT_MONO);
  textSize(11);
  textAlign(LEFT, TOP);
  text(handStatus + (modelReady ? '' : ' (loading model...)'), 0, 0);
  fill(COL_MUTED);
  textSize(10.5);
  text('Point in a direction to steer — arrow shows reading', 0, 18);
  pop();
}
