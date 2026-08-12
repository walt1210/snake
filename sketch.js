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
  createCanvas(PANEL_X + VIDEO_W + 20, GAME_H + 100);

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
  background(30);

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

function drawHeader() {
  fill(255);
  noStroke();
  textAlign(LEFT, TOP);
  textSize(16);
  text('Score: ' + snake.len, 10, 10);
  textSize(13);
  text('Direction: ' + currentDir, 150, 12);
  text('Speed: ' + moveInterval + 'ms/step', 260, 12);
}

function drawGame() {
  push();
  translate(0, 40);
  fill(220);
  noStroke();
  rect(0, 0, GAME_W, GAME_H);

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
  fill(255, 0, 0);
  rect(food.x, food.y, 1, 1);
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
  fill(200, 0, 0, 180);
  noStroke();
  rect(0, 0, GAME_W, GAME_H);
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(26);
  text('GAME OVER', GAME_W / 2, GAME_H / 2 - 20);
  textSize(16);
  text('Score: ' + snake.len, GAME_W / 2, GAME_H / 2 + 15);
  textSize(12);
  text('Press R or click Restart', GAME_W / 2, GAME_H / 2 + 40);
  pop();
}

function drawCalibrationScreen() {
  push();
  translate(0, 40);
  fill(220);
  noStroke();
  rect(0, 0, GAME_W, GAME_H);
  fill(20);
  textAlign(CENTER, CENTER);
  textSize(18);
  text('Steering test', GAME_W / 2, 40);
  textSize(13);
  text('Point your hand (fingers extended) in a direction\nin the camera panel to steer.', GAME_W / 2, 75);

  // Big directional readout so you can confirm tracking works before playing
  textSize(48);
  let label = candidateDir || '·';
  text(label, GAME_W / 2, GAME_H / 2);

  textSize(13);
  text('Press ENTER or click "Start Game" when ready', GAME_W / 2, GAME_H - 40);
  pop();
}

// Draws the 21-point hand skeleton (finger by finger) for whichever hand is
// currently being used to steer, in green. This is the debug view for
// confirming HandPose is actually tracking your hand and not something else.
function drawHandSkeleton(hand, isActive) {
  const kp = (name) => hand.keypoints.find(k => k.name === name);

  stroke(isActive ? color(0, 255, 0) : color(255, 255, 255, 90));
  strokeWeight(isActive ? 2.5 : 1);
  for (const chain of FINGER_CHAINS) {
    for (let i = 0; i < chain.length - 1; i++) {
      let a = kp(chain[i]);
      let b = kp(chain[i + 1]);
      if (a && b) line(a.x, a.y, b.x, b.y);
    }
  }

  noStroke();
  fill(isActive ? color(0, 255, 0) : color(200, 200, 200, 150));
  for (const k of hand.keypoints) {
    ellipse(k.x, k.y, 5, 5);
  }
}

function drawHandPanel() {
  push();
  translate(PANEL_X, PANEL_Y);

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

  // 3x3 grid overlay
  stroke(255, 255, 255, 150);
  strokeWeight(1);
  line(VIDEO_W / 3, 0, VIDEO_W / 3, VIDEO_H);
  line((2 * VIDEO_W) / 3, 0, (2 * VIDEO_W) / 3, VIDEO_H);
  line(0, VIDEO_H / 3, VIDEO_W, VIDEO_H / 3);
  line(0, (2 * VIDEO_H) / 3, VIDEO_W, (2 * VIDEO_H) / 3);

  // Diagonal quadrant-boundary guides (the 4 lines that split the circle
  // into RIGHT/DOWN/LEFT/UP 90-degree wedges), centered on the wrist-ish
  // middle of frame just as a visual reference for where the buckets are
  stroke(255, 255, 0, 120);
  strokeWeight(1);
  let cx = VIDEO_W / 2;
  let cy = VIDEO_H / 2;
  let guideLen = 70;
  line(cx - guideLen * cos(QUARTER_PI), cy - guideLen * sin(QUARTER_PI), cx + guideLen * cos(QUARTER_PI), cy + guideLen * sin(QUARTER_PI));
  line(cx - guideLen * cos(QUARTER_PI), cy + guideLen * sin(QUARTER_PI), cx + guideLen * cos(QUARTER_PI), cy - guideLen * sin(QUARTER_PI));

  // Pointing-direction arrow: drawn from the tracked hand's wrist, showing
  // the smoothed wrist->middle-finger vector currently being read as a
  // direction. Green once committed, orange while still building up.
  if (handStatus.startsWith('Tracking')) {
    let active = getValidHand();
    let wrist = active && active.keypoints.find(k => k.name === 'wrist');
    if (wrist) {
      let arrowLen = 60;
      let tipX = wrist.x + smoothVx * arrowLen;
      let tipY = wrist.y + smoothVy * arrowLen;
      let col = candidateCount >= HOLD_FRAMES ? color(0, 255, 0) : color(255, 165, 0);
      stroke(col);
      strokeWeight(3);
      line(wrist.x, wrist.y, tipX, tipY);
      noStroke();
      fill(col);
      ellipse(tipX, tipY, 10, 10);
    }
  }

  pop();

  // Status text below video panel
  fill(255);
  noStroke();
  textAlign(LEFT, TOP);
  textSize(13);
  text(handStatus + (modelReady ? '' : ' (loading model...)'), PANEL_X, PANEL_Y + VIDEO_H + 8);
  text('Point in a direction to steer (arrow shows reading)', PANEL_X, PANEL_Y + VIDEO_H + 26);
}
