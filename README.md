# 3d engine

I had no previous experience in the theoretical back bone of 3d modelling really, but as a curious
person I had a series of questions about it and it eventually led me to
this rudimentary 3d engine implementation. 

You can find a demo of it here: [https://me.ricardicus.se/6327c5040352eadd45ae679f31f8f38](https://me.ricardicus.se/6327c5040352eadd45ae679f31f8f38a)
or launch it locally with for example

```
python3 -m http.server
```

then visit localhost:8000. 

## Background

This started as a small experimental inefficient CPU 3D renderer built from scratch,
then it got more refined. I was inspired by a [Youtube video](https://www.youtube.com/watch?v=qjWkNZ0SXfo)
by the account "Tsoding" where the author just created one from scratch capable of rendering
a wire frame of the Linux penguin.

In that spirit, I started out just rendering wire frames with the CPU but I wanted
to be able to render forms built in CAD tools or produced from 3D scans.
In my website (me.ricardicus.se) I use point clouds that form a 3d scan of me
and that scan is stored as a GLB file. So I then wanted to be able to render a GLB file
in my own engine, and that vision has now succeeded. 

I was using chatGPT for the webGL implementation, but
it was a good thing because it could explain to what it was doing and I had no 
previous experience with shader programs, so I feel like I've learned a lot from that.
I also argued that webgl API is a bit old, and it (as it so often does) agreed with me.

### Itty-gritty comment

I find that the web GL API is a little strange. Consider these lines:

```javascript
  gl.bindBuffer(gl.ARRAY_BUFFER, drawable.positionBuffer);
  gl.enableVertexAttribArray(attribs.position);
  gl.vertexAttribPointer(attribs.position, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, drawable.uvBuffer);
  gl.enableVertexAttribArray(attribs.uv);
  gl.vertexAttribPointer(attribs.uv, 2, gl.FLOAT, false, 0, 0);
```

Whta is goind on here? When looking at "enableVertexAttribArray" and "vertexAttribPointer"
and the arguments they use, it isn't clear at all that they operate on the data provided by 
the command gl.bindBuffer(gl.ARRAY_BUFFER, drawable.positionBuffer). I would expect something
moore like 

```
// fake code
let buf = gl.bindBuffer(gl.ARRAY_BUFFER, drawable.positionBuffer);
gl.enableVertexAttribArray(buf, attribs.position);
gl.vertexAttribPointer(buf, attribs.position, 3, gl.FLOAT, false, 0, 0);
```

But there is a reason the API looks like this, as always, and it is because WebGL maintains internal state like:

```
CURRENT ARRAY_BUFFER = positionBuffer
```
Then when you call:
```
gl.vertexAttribPointer(location, ...)
```
it means:
“Use the buffer currently bound to ARRAY_BUFFER for this attribute”

I thought this was a bit curious. Apparently, OpenGL is a 1990s design, and back then state machines were common
and minimizing function arguments was also something considered important.

### Screenshot

You can navigate the word by moving the camera using the arrows (direction) and the W-A-S-D keys for moving forward-left(stride)-back-right(stride).
I took this screenshot:

![Preview](localhost_8000_.png)