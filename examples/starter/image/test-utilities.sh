#!/bin/sh
set -eu
test "$(grep '^nameserver ' /etc/resolv.conf)" = "nameserver 192.0.2.1"
test "$(readlink /bin/sh)" = dash
test "$(/bin/dash -c 'kill -l 2')" = INT
/bin/dash -c 'trap "exit 0" USR1; kill -USR1 $$; exit 1'
for command in dash mksh sh awk tr expr bc dc crond crontab getty last mount gzip gunzip xz unxz unzip tar diff cmp vi ssh dropbear curl stty env; do
  command -v "$command" >/dev/null
done
test "$(printf 'one two\n' | awk '{print NF}')" = 2
test "$(printf abc | tr a z)" = zbc
test "$(expr 2 + 3)" = 5
test "$(printf '2+3\n' | bc)" = 5
test "$(printf '2 3 + p\n' | dc)" = 5
test "$(printf compression | gzip -c | gunzip -c)" = compression
test "$(printf compression | xz -c | unxz -c)" = compression
curl --version | grep -q 'https'
ssh -V 2>&1 | grep -q Dropbear
dropbear -V 2>&1 | grep -q Dropbear
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
printf 'archive\n' > "$work/input"
cp "$work/input" "$work/copy"
cmp "$work/input" "$work/copy"
diff "$work/input" "$work/copy"
tar -cf "$work/test.tar" -C "$work" input
mkdir "$work/extracted"
tar -xf "$work/test.tar" -C "$work/extracted"
cmp "$work/input" "$work/extracted/input"
# Fixed stored ZIP fixture, with no external zip builder in the guest.
printf '%s' 'UEsDBBQAAAAAAIBMXF2hJbvLCAAAAAgAAAAFAAAAaW5wdXRhcmNoaXZlClBLAQIUAxQAAAAAAIBMXF2hJbvLCAAAAAgAAAAFAAAAAAAAAAAAAACAAQAAAABpbnB1dFBLBQYAAAAAAQABADMAAAArAAAAAAA=' | base64 -d > "$work/test.zip"
unzip -p "$work/test.zip" input | cmp - "$work/input"
test "$(printf abc | sha256sum | cut -d ' ' -f 1)" = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
printf 'oxidevm-utilities-ready\n'
