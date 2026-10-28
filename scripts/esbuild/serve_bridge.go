//go:build js && wasm && oxidevm_esbuild

// The upstream HTTP/TLS server remains unchanged. Only its OS transport changes.
package api

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"syscall"
	"syscall/js"
	"time"
)

var oxidevmNetwork = js.Global().Get("oxidevmEsbuild")

func oxidevmStart(method string, args ...interface{}) func() (js.Value, error) {
	type result struct {
		value js.Value
		err   error
	}
	completed := make(chan result, 1)
	callback := js.FuncOf(func(_ js.Value, values []js.Value) interface{} {
		value := result{value: js.Undefined()}
		if len(values) > 0 && !values[0].IsNull() {
			errno := values[0].Get("errno").Int()
			if errno == 0 {
				value.err = errors.New(values[0].Get("message").String())
			} else if errno == 110 {
				value.err = os.ErrDeadlineExceeded
			} else {
				value.err = syscall.Errno(errno)
			}
		} else if len(values) > 1 {
			value.value = values[1]
		}
		completed <- value
		return nil
	})
	oxidevmNetwork.Call(method, append(args, callback)...)
	return func() (js.Value, error) {
		defer callback.Release()
		resultValue := <-completed
		return resultValue.value, resultValue.err
	}
}

func oxidevmCall(method string, args ...interface{}) (js.Value, error) {
	return oxidevmStart(method, args...)()
}

type oxidevmDescriptor struct {
	fd     int
	mu     sync.Mutex
	closed bool
}

func (d *oxidevmDescriptor) call(method string, args ...interface{}) (js.Value, error) {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return js.Undefined(), net.ErrClosed
	}
	// Publish before releasing the lifetime lock. Close cannot overtake this request.
	wait := oxidevmStart(method, append([]interface{}{d.fd}, args...)...)
	d.mu.Unlock()
	return wait()
}

func (d *oxidevmDescriptor) Close() error {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return net.ErrClosed
	}
	d.closed = true
	wait := oxidevmStart("close", d.fd)
	d.mu.Unlock()
	_, err := wait()
	return err
}

func oxidevmAddress(value string) *net.TCPAddr {
	host, text, err := net.SplitHostPort(value)
	if err != nil {
		panic(err)
	}
	port, err := strconv.Atoi(text)
	if err != nil {
		panic(err)
	}
	return &net.TCPAddr{IP: net.ParseIP(host), Port: port}
}

type oxidevmListener struct {
	oxidevmDescriptor
	address net.Addr
}

func oxidevmListen(network, address string) (net.Listener, error) {
	host, text, err := net.SplitHostPort(address)
	if err != nil {
		return nil, &net.OpError{Op: "listen", Net: network, Err: err}
	}
	port, err := strconv.Atoi(text)
	if err != nil || port < 0 || port > 65535 {
		return nil, &net.OpError{Op: "listen", Net: network, Err: &net.AddrError{Err: "invalid port", Addr: text}}
	}
	value, err := oxidevmCall("listen", network, host, port)
	if err != nil {
		return nil, &net.OpError{Op: "listen", Net: network, Err: err}
	}
	return &oxidevmListener{oxidevmDescriptor: oxidevmDescriptor{fd: value.Get("fd").Int()}, address: oxidevmAddress(value.Get("local").String())}, nil
}

func (l *oxidevmListener) Accept() (net.Conn, error) {
	value, err := l.call("accept")
	if err != nil {
		return nil, &net.OpError{Op: "accept", Net: "tcp", Addr: l.address, Err: err}
	}
	return &oxidevmConnection{oxidevmDescriptor: oxidevmDescriptor{fd: value.Get("fd").Int()}, local: oxidevmAddress(value.Get("local").String()), peer: oxidevmAddress(value.Get("peer").String())}, nil
}

func (l *oxidevmListener) Addr() net.Addr { return l.address }

type oxidevmConnection struct {
	oxidevmDescriptor
	local, peer net.Addr
}

func (c *oxidevmConnection) Read(output []byte) (int, error) {
	if len(output) == 0 {
		return 0, nil
	}
	length := len(output)
	if length > 65536 {
		length = 65536
	}
	bytes := js.Global().Get("Uint8Array").New(length)
	value, err := c.call("read", bytes)
	if err != nil {
		return 0, &net.OpError{Op: "read", Net: "tcp", Source: c.local, Addr: c.peer, Err: err}
	}
	n := value.Int()
	js.CopyBytesToGo(output[:n], bytes)
	if n == 0 {
		return 0, io.EOF
	}
	return n, nil
}

func (c *oxidevmConnection) Write(input []byte) (int, error) {
	bytes := js.Global().Get("Uint8Array").New(len(input))
	js.CopyBytesToJS(bytes, input)
	value, err := c.call("write", bytes)
	if err != nil {
		return 0, &net.OpError{Op: "write", Net: "tcp", Source: c.local, Addr: c.peer, Err: err}
	}
	return value.Int(), nil
}

func (c *oxidevmConnection) LocalAddr() net.Addr  { return c.local }
func (c *oxidevmConnection) RemoteAddr() net.Addr { return c.peer }

func (c *oxidevmConnection) deadline(direction string, deadline time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return net.ErrClosed
	}
	value := ""
	if !deadline.IsZero() {
		value = strconv.FormatInt(deadline.UnixMilli(), 10)
	}
	oxidevmNetwork.Call("deadline", c.fd, direction, value)
	return nil
}

func (c *oxidevmConnection) SetDeadline(t time.Time) error      { return c.deadline("both", t) }
func (c *oxidevmConnection) SetReadDeadline(t time.Time) error  { return c.deadline("read", t) }
func (c *oxidevmConnection) SetWriteDeadline(t time.Time) error { return c.deadline("write", t) }

func oxidevmInterfaceAddrs() ([]net.Addr, error) {
	value, err := oxidevmCall("interfaces")
	if err != nil {
		return nil, err
	}
	addresses := make([]net.Addr, 0, value.Length())
	for i := 0; i < value.Length(); i++ {
		ip, address, err := net.ParseCIDR(value.Index(i).String())
		if err != nil {
			return nil, fmt.Errorf("invalid Rust interface address: %w", err)
		}
		address.IP = ip
		addresses = append(addresses, address)
	}
	return addresses, nil
}
