WARNING

THIS PROJECT IS STILL IN EARLY DEVELOPMENT, USES EXPERIMENTAL
CRYPTOGRAPHIC LIBRARIES, AND HAS NOT HAD ANY KIND OF SECURITY OR
CRYPTOGRAPHY REVIEWS. IT MIGHT BE BROKEN AND UNSAFE.

![https://xkcd.com/949/](https://imgs.xkcd.com/comics/file_transfer.png)

WebWormhole creates ephemeral pipes between computers to send files
or other data. Try it at https://webwormhole.io or on the command
line.

On one computer the tool generates a one-time code for us:

    $ cat hello.txt
    hello, world
    $ ww send hello.txt
    8-enlist-decadence

On another we use the code to establish a connection:

    $ ww receive 8-enlist-decadence
    $ cat hello.txt
    hello, world

It is inspired by and uses a model very similar to that of Magic
Wormhole. Thanks Brian!

[https://github.com/warner/magic-wormhole](https://github.com/warner/magic-wormhole)

WebWormhole differs from Magic Wormhole in that it uses WebRTC
to make the direct peer connections. This allows us to make use of
WebRTC's NAT traversal tricks, as well as the fact that it can be
used in browsers. The exchange of session descriptions (offers and
answers) is protected by PAKE and a generated random password,
similar to Magic Wormhole. The session descriptions include the
fingerprints of the DTLS certificates that WebRTC uses to secure
its communications.

To run locally:

    $ make serve

To install (requires at least golang-1.13):

    $ go get -u webwormhole.io/cmd/ww

Unless otherwise noted, the source files are distributed under the
BSD-style license found in the LICENSE file.
