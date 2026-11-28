on run argv
	set platformURL to item 1 of argv
	set outputPath to item 2 of argv
	if application "Google Chrome" is not running then error "Chrome is not running"
	tell application "Google Chrome"
		if (count of windows) is 0 then error "An existing Chrome window is required"
		set originalWindow to front window
		set previousActiveID to id of active tab of originalWindow
		set ownedTab to make new tab at end of tabs of originalWindow with properties {URL:platformURL}
		try
			repeat 80 times
				delay 0.15
				set loadedURL to URL of ownedTab
				if loadedURL is not "" and loadedURL is not "about:blank" and not (loading of ownedTab) then exit repeat
			end repeat
			if loadedURL is not platformURL then error "Platform redirected this read"
			if loading of ownedTab then error "Platform page did not finish loading"
			save ownedTab in (POSIX file outputPath) as "only html"
			repeat 20 times
				try
					do shell script "/bin/test -s " & quoted form of outputPath
					exit repeat
				on error
					delay 0.15
				end try
			end repeat
		on error messageText number code
			my closeOwnedTab(originalWindow, ownedTab, previousActiveID)
			error messageText number code
		end try
		my closeOwnedTab(originalWindow, ownedTab, previousActiveID)
	end tell
end run

on closeOwnedTab(originalWindow, ownedTab, previousActiveID)
	tell application "Google Chrome"
		try
			set shouldRestore to (id of active tab of originalWindow = id of ownedTab)
			close ownedTab
			if shouldRestore then
				repeat with idx from 1 to (count of tabs of originalWindow)
					if (id of tab idx of originalWindow) is previousActiveID then
						set active tab index of originalWindow to idx
						exit repeat
					end if
				end repeat
			end if
		end try
	end tell
end closeOwnedTab
