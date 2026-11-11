; Pathline Run's Windows Firewall rules (hmi/RUN-DISCOVERY-BRIEF.md, hmi/RUN-MONITOR-BRIEF.md):
;  - TCP in: Pathline Prepare's and Pathline Monitor's requests, and their network scan (8470, or
;    whichever port Setup sets: the rule is for Pathline Run's program, whatever port it uses)
;  - UDP 5353 in: mDNS questions, so Prepare and Monitor find the machine without an IP address
; Both are for Pathline Run only, on private networks (set the workshop network to Private in
; Windows; a Public network blocks them). Removed again on uninstall. An existing rule of the same
; name is replaced, so updating doesn't pile up copies.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run (discovery)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Pathline Run" dir=in action=allow protocol=TCP profile=private program="$INSTDIR\Pathline Run.exe" enable=yes'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Pathline Run (discovery)" dir=in action=allow protocol=UDP localport=5353 profile=private program="$INSTDIR\Pathline Run.exe" enable=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run (discovery)"'
!macroend
