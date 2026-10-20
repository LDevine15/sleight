/* The shell bridge checks the connected Unix peer, never a uid from the request. */
#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdio.h>

int main(void) {
  struct sockaddr_un address;
  socklen_t length = sizeof(address);
  uid_t uid;
  if (getpeername(3, (struct sockaddr *)&address, &length) || address.sun_family != AF_UNIX) return 1;
#ifdef __APPLE__
  gid_t gid;
  if (getpeereid(3, &uid, &gid)) return 1;
#elif defined(__linux__)
  struct ucred peer;
  length = sizeof(peer);
  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &peer, &length) || length != sizeof(peer)) return 1;
  uid = peer.uid;
#else
  return 1;
#endif
  if (uid != getuid()) return 1;
  printf("%lu\n", (unsigned long)uid);
  return 0;
}
