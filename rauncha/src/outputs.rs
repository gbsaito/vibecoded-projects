//! Output size probe: tiny wayland-client roundtrip to size the panel
//! (25% of screen width, fuzzel-style) before the layer-shell boots.
//!
//! ponytail: picks the biggest current mode; multi-output could follow the
//! focused one — upgrade via layershellev's active-output if it matters.

use wayland_client::protocol::{wl_output, wl_registry};
use wayland_client::{Connection, Dispatch, QueueHandle};

#[derive(Default)]
struct Probe {
    sizes: Vec<(i32, i32)>,
}

impl Dispatch<wl_registry::WlRegistry, ()> for Probe {
    fn event(
        _state: &mut Self,
        registry: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _data: &(),
        _conn: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name, interface, version, ..
        } = event
        {
            if interface == "wl_output" {
                registry.bind::<wl_output::WlOutput, (), Self>(name, version.min(4), qh, ());
            }
        }
    }
}

impl Dispatch<wl_output::WlOutput, ()> for Probe {
    fn event(
        state: &mut Self,
        _output: &wl_output::WlOutput,
        event: wl_output::Event,
        _data: &(),
        _conn: &Connection,
        _qh: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Mode { flags, width, height, .. } = event {
            if let wayland_client::WEnum::Value(flags) = flags {
                if flags.contains(wl_output::Mode::Current) {
                    state.sizes.push((width, height));
                }
            }
        }
    }
}

/// (width, height) of what we assume is the launcher's output.
pub fn focus_output_size() -> Option<(i32, i32)> {
    let conn = Connection::connect_to_env().ok()?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    let mut probe = Probe::default();
    queue.roundtrip(&mut probe).ok()?; // globals
    queue.roundtrip(&mut probe).ok()?; // output modes
    probe.sizes.into_iter().max_by_key(|&(w, h)| (h, w))
}
