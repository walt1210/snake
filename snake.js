class Snake {
  
  constructor() {
  	this.body = [];
    this.body[0] = createVector(floor(w/2), floor(h/2));
    this.xdir = 0;
    this.ydir = 0;
    this.len = 0;
  }
  
  setDir(x, y) {
  	this.xdir = x;
    this.ydir = y;
  }
  
  update() {
  	let head = this.body[this.body.length-1].copy();
    this.body.shift();
    head.x += this.xdir;
    head.y += this.ydir;
    this.body.push(head);
  }
  
  grow() {
  	let head = this.body[this.body.length-1].copy();
    this.len++;
    //document.getElementById("myScore").innerHTML = "Score: "+this.len;
    this.body.push(head);
  }
  
  endGame() {
  	let x = this.body[this.body.length-1].x;
    let y = this.body[this.body.length-1].y;
    if(x > w-1 || x < 0 || y > h-1 || y < 0) {
       return true;
    }
    for(let i = 0; i < this.body.length-1; i++) {
    	let part = this.body[i];
      if(part.x == x && part.y == y) {
      	return true;
      }
    }
    return false;
  }
  
  eat(pos) {
  	let x = this.body[this.body.length-1].x;
    let y = this.body[this.body.length-1].y;
    if(x == pos.x && y == pos.y) {
      this.grow();
      return true;
    }
    return false;
  }
  
  show() {
  	noStroke();
  	for(let i = 0; i < this.body.length; i++) {
      let isHead = i === this.body.length - 1;
      // Head reads as a bright cream so direction is always obvious at a
      // glance; body fades toward a deeper coral tail so motion has a sense
      // of "trail" rather than a flat solid block.
      if (isHead) {
        fill('#EDEAE3');
      } else {
        let t = i / max(1, this.body.length - 2);
        fill(lerpColor(color('#B23A4E'), color('#FF6B7A'), t));
      }
      rect(this.body[i].x, this.body[i].y, 1, 1, 0.25);
    }
  }

}