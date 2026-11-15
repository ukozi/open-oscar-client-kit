# Porting open-oscar-client-kit

A port is a client library for OSCAR in another language. This project does not maintain ports. Port authors test against the byte vectors and the test server of this project, and prove the finished port with the suite, which drives it through a small program called a driver.

The source of the [core](../protocol/overview.md) is the reference: `src/wire` holds the codec, and `src/client` holds sign-on, reconnects and the login budget. The [protocol guide](../protocol/overview.md) describes the wire format, and the [API reference](../api/README.md) documents the core's functions.

## Building a port

1. Write the FLAP, SNAC and TLV codec.
2. Test the codec against the [byte vectors](vectors.md).
3. Write the sign-on that [Sign-on](../protocol/sign-on.md) describes.
4. Start the [test server](test-server.md).
5. Sign on to the test server as `Bot`, with the password `botpass1`.
6. Write a [driver](driver-protocol.md) for the port.
7. Run the [suite](suite.md) against the driver.
8. Add the suite to the port's CI.
9. Open an issue to [list the port](../ports.md).

The suite checks behavior as well as bytes. A port passes only when it keeps to the server's rate classes, waits before it reconnects, and stops after a refused login or a sign-off by the server.

## The name

A port may not call itself open-oscar-client-kit. A port that passes the suite may say "passes the open-oscar-client-kit suite, version N", where N is the version on the first line of the suite's output. The MIT license covers the code, not the name.
