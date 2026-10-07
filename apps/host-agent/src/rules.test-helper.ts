/** Test data shared by the agent tests. */

/** `iptables -S FORWARD` as the runbook's rules print it. */
export const RUNBOOK_RULES = [
  "-P FORWARD ACCEPT",
  "-A FORWARD -s 10.30.0.0/24 -d 10.20.0.0/24 -j DROP",
  "-A FORWARD -s 10.30.0.0/24 -p tcp -m multiport --dports 25,465,587 -j DROP",
  "-A FORWARD -s 10.30.0.0/24 -p tcp -m tcp --tcp-flags FIN,SYN,RST,ACK SYN -m hashlimit --hashlimit-above 50/sec --hashlimit-burst 5 --hashlimit-mode srcip --hashlimit-name c1 -j DROP",
  "-A FORWARD -o vmbr10 -m conntrack ! --ctstate RELATED,ESTABLISHED -j DROP",
].join("\n");
