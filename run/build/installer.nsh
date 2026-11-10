; Pathline Run's Windows Firewall rules (hmi/RUN-DISCOVERY-BRIEF.md):
;  - TCP in: Pathline Prepare's requests, and its network scan (8470, or whichever port Setup
;    sets: the rule is for Pathline Run's program, whatever port it listens on)
;  - UDP 5353 in: mDNS questions, so Prepare finds the machine without an IP address
; Both are for Pathline Run only, on any network profile (Windows still blocks discovery on a
; Public network). Removed again on uninstall. An existing rule of the same name is replaced,
; so updating doesn't pile up copies.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run (discovery)"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Pathline Run" dir=in action=allow protocol=TCP program="$INSTDIR\Pathline Run.exe" enable=yes'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Pathline Run (discovery)" dir=in action=allow protocol=UDP localport=5353 program="$INSTDIR\Pathline Run.exe" enable=yes'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pathline Run (discovery)"'
!macroend
