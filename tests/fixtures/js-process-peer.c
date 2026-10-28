// SPDX-License-Identifier: Apache-2.0
// Native Linux oracle for the JS service boundary. Compile with musl-gcc -static.
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int transfer(int fd, void *buffer, size_t length, int writing) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t count = writing ? write(fd, (char *)buffer + offset, length - offset)
                                : read(fd, (char *)buffer + offset, length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        offset += (size_t)count;
    }
    return 0;
}

static int bulk(int fd, unsigned char value, int writing) {
    unsigned char bytes[16384], expected[16384];
    memset(expected, value, sizeof expected);
    for (size_t offset = 0; offset < 2 * 1024 * 1024; offset += sizeof bytes) {
        if (writing) memcpy(bytes, expected, sizeof bytes);
        if (transfer(fd, bytes, sizeof bytes, writing) != 0) return -1;
        if (!writing && memcmp(bytes, expected, sizeof bytes) != 0) return -1;
    }
    return 0;
}

static int socket_peer(const char *operation, const char *endpoint) {
    int unix_socket = strncmp(operation, "unix-", 5) == 0;
    int server = strstr(operation, "server") != NULL;
    int fd = socket(unix_socket ? AF_UNIX : AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return 101;
    struct sockaddr_un un = { .sun_family = AF_UNIX };
    struct sockaddr_in inet = { .sin_family = AF_INET, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    const struct sockaddr *address;
    socklen_t length;
    if (unix_socket) {
        if (strlen(endpoint) >= sizeof un.sun_path) return 102;
        strcpy(un.sun_path, endpoint);
        address = (const struct sockaddr *)&un; length = sizeof un;
    } else {
        inet.sin_port = htons((unsigned short)atoi(endpoint));
        address = (const struct sockaddr *)&inet; length = sizeof inet;
    }
    int stream;
    if (server) {
        if (unix_socket) unlink(endpoint);
        if (bind(fd, address, length) != 0 || listen(fd, 4) != 0) return 103;
        if (!unix_socket && getsockname(fd, (struct sockaddr *)&inet, &length) != 0) return 104;
        printf("ready:%u\n", unix_socket ? 0 : ntohs(inet.sin_port)); fflush(stdout);
        stream = accept(fd, NULL, NULL);
        if (stream < 0) return 105;
    } else {
        if (connect(fd, address, length) != 0) return 106;
        stream = fd;
    }
    char message[4];
    if (strstr(operation, "bulk") != NULL) {
        if (server) { if (bulk(stream, 0xa5, 0) != 0 || bulk(stream, 0x5a, 1) != 0) return 115; }
        else if (bulk(stream, 0x5a, 1) != 0 || bulk(stream, 0xa5, 0) != 0) return 116;
    } else if (server) {
        if (transfer(stream, message, 4, 0) != 0 || memcmp(message, "ping", 4) != 0 || transfer(stream, "pong", 4, 1) != 0) return 107;
    } else {
        if (transfer(stream, "ping", 4, 1) != 0 || transfer(stream, message, 4, 0) != 0 || memcmp(message, "pong", 4) != 0) return 108;
    }
    close(stream); if (server) close(fd); if (server && unix_socket) unlink(endpoint);
    return 7;
}

int main(int argc, char **argv) {
    if (argc < 2) return 100;
    if (strcmp(argv[1], "metadata") == 0) {
        char cwd[4096]; if (getcwd(cwd, sizeof cwd) == NULL) return 109;
        printf("pid=%d ppid=%d uid=%d gid=%d cwd=%s arg=%s env=%s\n", getpid(), getppid(), getuid(), getgid(), cwd, argc > 2 ? argv[2] : "", getenv("BRIDGE_TEST") == NULL ? "" : getenv("BRIDGE_TEST"));
        return 23;
    }
    if (strcmp(argv[1], "read-permission") == 0 && argc == 3) {
        int fd = open(argv[2], O_RDONLY); int result = fd < 0 ? errno : 0;
        if (fd >= 0) close(fd);
        printf("%d\n", result);
        return 0;
    }
    if (strcmp(argv[1], "echo") == 0) {
        char bytes[17]; ssize_t count;
        while ((count = read(STDIN_FILENO, bytes, sizeof bytes)) > 0) if (transfer(STDOUT_FILENO, bytes, (size_t)count, 1) != 0) return 110;
        return count < 0 ? 111 : 7;
    }
    if (strcmp(argv[1], "wait-signal") == 0) { for (;;) pause(); }
    if (strcmp(argv[1], "write-later") == 0 && argc == 3) {
        if (usleep(100000) != 0) return 113;
        int fd = open(argv[2], O_CREAT | O_TRUNC | O_WRONLY, 0600);
        if (fd < 0 || transfer(fd, "orphan", 6, 1) != 0) return 114;
        close(fd); return 0;
    }
    if (argc == 3 && (strncmp(argv[1], "tcp-", 4) == 0 || strncmp(argv[1], "unix-", 5) == 0)) return socket_peer(argv[1], argv[2]);
    return 112;
}
