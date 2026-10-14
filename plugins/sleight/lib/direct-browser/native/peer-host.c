/* Original sleight source. Darwin peer metadata only; no app or input APIs. */
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/proc_info.h>
#include <libproc.h>
#include <bsm/libbsm.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--peer-fd") || strcmp(argv[2], "3")) return 64;
  struct sockaddr_un address;
  socklen_t length = sizeof(address);
  uid_t uid; gid_t gid; pid_t pid = 0;
  struct proc_bsdinfo info;
  memset(&info, 0, sizeof(info));
  if (getpeername(3, (struct sockaddr *)&address, &length) || address.sun_family != AF_UNIX ||
      getpeereid(3, &uid, &gid) || uid != getuid()) return 65;
  length = sizeof(pid);
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) || length != sizeof(pid)) return 65;
  audit_token_t token;
  length = sizeof(token);
  if (getsockopt(3, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) || length != sizeof(token) ||
      audit_token_to_pid(token) != pid || audit_token_to_euid(token) != uid) return 65;
  if (pid < 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info) ||
      info.pbi_pid != (unsigned)pid || info.pbi_uid != uid || !info.pbi_start_tvsec) return 65;
  printf("{\"uid\":%u,\"pid\":%d,\"incarnation\":\"p%d-v%u\"}\n",
    uid, pid, pid, (unsigned)audit_token_to_pidversion(token));
  return 0;
}
