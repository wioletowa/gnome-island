UUID := gnome-island@whyoolw
SOURCES := bridge.js config.js island.js media.js notifications.js odometer.js \
	pipewire.js privacy.js spring.js symmetric.js views.js visualizer.js
ZIP := dist/$(UUID).shell-extension.zip
DATA_HOME := $(or $(XDG_DATA_HOME),$(HOME)/.local/share)
DEST := $(DATA_HOME)/gnome-shell/extensions/$(UUID)

.PHONY: pack install clean

# extension.js, prefs.js, metadata.json, stylesheet.css and schemas/ are
# picked up by gnome-extensions automatically.
pack:
	@mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --podir=po \
		$(addprefix --extra-source=,$(SOURCES) LICENSE) .

# Unpack the bundle and compile the schema (the zip only carries the XML).
install: pack
	rm -rf $(DEST)
	mkdir -p $(DEST)
	unzip -q $(ZIP) -d $(DEST)
	glib-compile-schemas $(DEST)/schemas

clean:
	rm -rf dist
