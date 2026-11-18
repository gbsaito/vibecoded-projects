//! The iced program: prompt + filtered list + selection + fuzzel styling.

use iced::font::Family;
use iced::widget::{column, container, row, text, text_input};
use iced::{Element, Font, Length, Task};
use iced_layershell::reexport::{Anchor, KeyboardInteractivity, Layer};
use iced_layershell::settings::{LayerShellSettings, Settings, StartMode};
use iced_layershell::{application, to_layer_message, Error};

use crate::config::{color, Config};
use crate::entries::{Entry, Store};

#[to_layer_message]
#[derive(Debug, Clone)]
pub enum Message {
    Input(String),
    Event(iced::Event),
    RowPress(usize),
    RowHover(usize),
}

#[derive(Debug)]
struct App {
    config: Config,
    filter: String,
    selected: usize,
    store: Store,
    /// Focus target: the prompt starts focused so typing filters from boot.
    input_id: iced::widget::Id,
}

pub const SCREEN_FALLBACK: (i32, i32) = (1920, 1080);

pub fn run(config: Config, screen: (i32, i32)) -> Result<(), Error> {
    let panel_color = color(&config.colors.background);
    let text_color = color(&config.colors.text);

    // 'static family: leak the (tiny) name; process lives as long as the panel.
    let font = Font {
        family: Family::Name(Box::leak(config.font.clone().into_boxed_str())),
        ..Font::default()
    };

    let (screen_w, screen_h) = (screen.0.max(0) as u32, screen.1.max(0) as u32);
    let size = (width(&config, screen_w), panel_height(&config));
    // Centered: unanchored surface + margins (top, right, bottom, left).
    let margins = (
        (screen_h.saturating_sub(size.1) / 2) as i32,
        (screen_w.saturating_sub(size.0) / 2) as i32,
        (screen_h.saturating_sub(size.1) / 2) as i32,
        (screen_w.saturating_sub(size.0) / 2) as i32,
    );

    let boot_id = iced::widget::Id::unique();
    application(
        move || {
            (
                App {
                    config: config.clone(),
                    filter: String::new(),
                    selected: 0,
                    store: Store::scan(),
                    input_id: boot_id.clone(),
                },
                iced::widget::operation::focus::<Message>(boot_id.clone()),
            )
        },
        namespace,
        update,
        view,
    )
    .style(move |_, _| iced::theme::Style {
        background_color: panel_color,
        text_color,
    })
    .default_font(font)
    .subscription(subscription)
    .settings(Settings {
        layer_settings: LayerShellSettings {
            size: Some(size),
            anchor: Anchor::empty(),
            margin: margins,
            layer: Layer::Top,
            exclusive_zone: -1,
            keyboard_interactivity: KeyboardInteractivity::Exclusive,
            start_mode: StartMode::Active,
            ..LayerShellSettings::default()
        },
        ..Settings::default()
    })
    .run()
    .map(|result| {
        eprintln!(
            "rauncha: layer-shell exited (panel {}x{}, margins {margins:?})",
            size.0, size.1
        );
        result
    })
}

pub fn width(config: &Config, screen_w: u32) -> u32 {
    (screen_w * config.width / 100).clamp(320, screen_w)
}

/// Total panel height matching the drawn layout:
/// border*2 + outer padding*2 + prompt row (input+counter share one line,
/// skipped when `prompt-visible = false`) + `lines` rows, + 4px fudge.
/// ponytail: pixel-math; tune against real glyph metrics if rows clip.
pub fn panel_height(config: &Config) -> u32 {
    // iced derives text height from LineHeight::Relative(1.3); ceil matches it.
    let line = (config.size * 1.3).ceil() as u32;
    let row = line + 4;
    let prompt_term = if config.prompt_visible {
        line + (config.inner_pad * 1.5) as u32
    } else {
        0
    };
    2 * (config.border.width as u32 + config.vertical_pad as u32)
        + prompt_term
        + config.lines as u32 * row
        + 4
}

fn namespace() -> String {
    String::from("rauncha")
}

fn subscription(_app: &App) -> iced::Subscription<Message> {
    iced::event::listen().map(Message::Event)
}

fn update(app: &mut App, message: Message) -> Task<Message> {
    match message {
        Message::Input(filter) => {
            app.filter = filter;
            app.selected = 0;
        }
        Message::RowHover(index) => {
            app.selected = index.min(app.store.total().saturating_sub(1));
        }
        Message::RowPress(index) => {
            app.selected = index;
            return launch_task(app);
        }
        Message::Event(iced::Event::Keyboard(iced::keyboard::Event::KeyPressed { key, .. })) => {
            if let iced::keyboard::Key::Named(named) = key {
                match named {
                    iced::keyboard::key::Named::Escape => return quit_task(),
                    iced::keyboard::key::Named::ArrowDown => {
                        if app.selected + 1 < app.store.filter(&app.filter).len() {
                            app.selected += 1;
                        }
                    }
                    iced::keyboard::key::Named::ArrowUp => {
                        app.selected = app.selected.saturating_sub(1);
                    }
                    iced::keyboard::key::Named::Enter => return launch_task(app),
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Task::none()
}

/// Launch the selected entry, then exit.
fn launch_task(app: &App) -> Task<Message> {
    if let Some(entry) = app.store.filter(&app.filter).get(app.selected) {
        crate::entries::launch(&entry.exec);
        return quit_task();
    }
    Task::none()
}

fn quit_task() -> Task<Message> {
    // ponytail: hard exit because iced has no runtime-exit task; a launcher has
    // nothing to clean up.
    Task::perform(async { std::process::exit(0) }, |_| Message::Input(String::new()))
}

fn view<'a>(app: &'a App) -> Element<'a, Message> {
    let c = &app.config;

    let target = app.store.filter(&app.filter);
    let total = target.len();
    let sel = app.selected.min(total.saturating_sub(1));
    let query = app.filter.to_lowercase();

    // Scroll window: fuzzel-style pages — a whole page jumps at a time when
    // the cursor passes the last row, selection never wraps.
    let lines = c.lines.max(1);
    let start = if total <= lines {
        0
    } else {
        (sel / lines) * lines
    };
    let mut list = column![];
    for (i, entry) in target.iter().enumerate().skip(start).take(lines) {
        list = list.push(entry_row(c, entry, i, sel, &query));
    }

    let border_color = color(&c.colors.border);

    // Results count lives beside the prompt, fuzzel-style.
    let counter = text(format!(" {}/{} ", total, app.store.total()))
        .size(c.size * 3.0 / 4.0)
        .align_y(iced::alignment::Vertical::Center)
        .color(color(&c.colors.counter));

    // iced's text_input defaults to 5px vertical padding; zero it or the prompt
    // row runs taller than panel_height budgets and bottom rows clip.
    let input = text_input("", &app.filter)
        .id(app.input_id.clone())
        .padding(iced::Padding::ZERO)
        .on_input(Message::Input)
        .size(c.size)
        .width(Length::Fill)
        .style(move |_, _| iced::widget::text_input::Style {
            background: iced::Background::Color(iced::Color::TRANSPARENT),
            border: iced::Border::default(),
            icon: color(&c.colors.input),
            placeholder: color(&c.colors.placeholder),
            value: color(&c.colors.input),
            selection: color(&c.colors.selection),
        });
    // Config compat: fuzzel-style prompt glyph only when set.
    let prompt: Element<'a, Message> = if c.prompt.is_empty() {
        row![input, counter].into()
    } else {
        row![text(format!("{} ", c.prompt))
            .size(c.size)
            .color(color(&c.colors.prompt)), input, counter]
            .into()
    };

    let inner = if c.prompt_visible {
        column![
            container(prompt).padding(iced::Padding {
                top: c.inner_pad * 0.75,
                bottom: c.inner_pad * 0.75,
                left: c.inner_pad * 0.5,
                right: c.inner_pad * 0.5,
            }),
            container(list).height(Length::Fill),
        ]
    } else {
        // Prompt hidden: list only, no counter either (it lives in that row).
        column![container(list).height(Length::Fill)]
    }
    .padding([c.vertical_pad as f32, c.horizontal_pad as f32])
    .width(Length::Fill)
    .height(Length::Fill);

    // Fuzzel-style border around the whole panel.
    let border_width = c.border.width;
    let border_radius = c.border.radius;
    container(inner)
        .width(Length::Fill)
        .height(Length::Fill)
        .style(move |_| iced::widget::container::Style {
            border: iced::Border {
                color: border_color,
                width: border_width,
                radius: border_radius.into(),
            },
            ..iced::widget::container::Style::default()
        })
        .into()
}

/// One menu row: padded name, matched substring recolored, selection bg.
fn entry_row<'a>(
    c: &Config,
    entry: &Entry,
    index: usize,
    selected: usize,
    query: &str,
) -> Element<'a, Message> {
    let is_selected = index == selected;

    let painted = |s: &str, color_str: &str| -> Element<'a, Message> {
        text(s.to_string())
            .size(c.size)
            .color(color(color_str))
            .into()
    };

    let content: Element<'a, Message> = if !query.is_empty() {
        match entry.name.to_lowercase().find(query) {
            Some(hit) => {
                let (pre, mid) = entry.name.split_at(hit);
                let (mid, post) = mid.split_at(query.len());
                row![
                    painted(pre, &c.colors.text),
                    painted(
                        mid,
                        if is_selected {
                            &c.colors.selection_match
                        } else {
                            &c.colors.match_
                        }
                    ),
                    painted(post, &c.colors.text),
                ]
                .into()
            }
            None => plain_name(c, entry, is_selected),
        }
    } else {
        plain_name(c, entry, is_selected)
    };

    let bg = if is_selected {
        color(&c.colors.selection)
    } else {
        iced::Color::TRANSPARENT
    };

    let row_widget = container(content)
        .padding(iced::Padding {
            top: 2.0,
            bottom: 2.0,
            left: c.inner_pad,
            right: c.inner_pad,
        })
        .style(move |_| iced::widget::container::Style {
            background: Some(bg.into()),
            ..iced::widget::container::Style::default()
        })
        .width(Length::Fill);

    // Mouse: hover selects, click launches.
    iced::widget::mouse_area(row_widget)
        .on_enter(Message::RowHover(index))
        .on_press(Message::RowPress(index))
        .interaction(iced::mouse::Interaction::Pointer)
        .into()
}

/// Unmatched row: whole name in text/selection-text color.
fn plain_name(c: &Config, entry: &Entry, is_selected: bool) -> Element<'static, Message> {
    text(entry.name.clone())
        .size(c.size)
        .color(color(if is_selected {
            &c.colors.selection_text
        } else {
            &c.colors.text
        }))
        .into()
}
