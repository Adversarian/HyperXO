use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use local_ip_address;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;
use warp::ws::{Message, WebSocket};
use warp::Filter;

static FRONTEND_DIST: Dir = include_dir!("$CARGO_MANIFEST_DIR/../dist");

type Tx = tokio::sync::mpsc::UnboundedSender<Message>;

struct Room {
    host: Option<Tx>,
    guest: Option<Tx>,
}

type Rooms = Arc<RwLock<HashMap<String, Arc<Mutex<Room>>>>>;

pub async fn start_signaling_server(port: u16) {
    let rooms: Rooms = Arc::new(RwLock::new(HashMap::new()));

    let ip = local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string());
    let base_url = format!("http://{}:{}", ip, port);

    let rooms_create = rooms.clone();
    let base_url_create = base_url.clone();
    let create_room = warp::post()
        .and(warp::path!("api" / "room"))
        .and_then(move || {
            let rooms = rooms_create.clone();
            let base = base_url_create.clone();
            async move {
                let room_id = Uuid::new_v4().to_string()[..6].to_uppercase();
                let room = Arc::new(Mutex::new(Room {
                    host: None,
                    guest: None,
                }));
                rooms.write().await.insert(room_id.clone(), room);
                let join_url = format!("{}/?room={}", base, room_id);
                Ok::<_, warp::Rejection>(warp::reply::json(&serde_json::json!({
                    "roomId": room_id,
                    "joinUrl": join_url
                })))
            }
        });

    let rooms_inspect = rooms.clone();
    let inspect_room = warp::get()
        .and(warp::path!("api" / "room" / String))
        .and_then(move |room_id: String| {
            let rooms = rooms_inspect.clone();
            async move {
                let id = room_id.trim().to_uppercase();
                let map = rooms.read().await;
                match map.get(&id) {
                    Some(room) => {
                        let r = room.lock().await;
                        let mut slots: Vec<&str> = vec![];
                        if r.host.is_none() {
                            slots.push("host");
                        }
                        if r.guest.is_none() {
                            slots.push("guest");
                        }
                        Ok::<_, warp::Rejection>(warp::reply::json(&serde_json::json!({
                            "roomId": id,
                            "available": !slots.is_empty(),
                            "availableSlots": slots
                        })))
                    }
                    None => Ok(warp::reply::json(&serde_json::json!({
                        "error": "Room not found"
                    }))),
                }
            }
        });

    let rooms_ws = rooms.clone();
    let ws_route = warp::path!("ws" / "room" / String).and(warp::ws()).map(
        move |room_id: String, ws: warp::ws::Ws| {
            let rooms = rooms_ws.clone();
            ws.on_upgrade(move |socket| handle_ws(socket, room_id, rooms))
        },
    );

    let cors = warp::cors()
        .allow_any_origin()
        .allow_methods(vec!["GET", "POST"])
        .allow_headers(vec!["Content-Type"]);

    // Serve static frontend files for browser clients (phone joining via QR)
    let static_assets =
        warp::path("assets")
            .and(warp::path::tail())
            .map(|tail: warp::path::Tail| {
                let path = format!("assets/{}", tail.as_str());
                match FRONTEND_DIST.get_file(&path) {
                    Some(file) => {
                        let mime = if path.ends_with(".js") {
                            "application/javascript"
                        } else if path.ends_with(".css") {
                            "text/css"
                        } else {
                            "application/octet-stream"
                        };
                        warp::http::Response::builder()
                            .header("Content-Type", mime)
                            .body(file.contents().to_vec())
                            .unwrap()
                    }
                    None => warp::http::Response::builder()
                        .status(404)
                        .body(b"Not Found".to_vec())
                        .unwrap(),
                }
            });

    let index_html = warp::get()
        .and(warp::path::tail())
        .map(
            |_tail: warp::path::Tail| match FRONTEND_DIST.get_file("index.html") {
                Some(file) => warp::http::Response::builder()
                    .header("Content-Type", "text/html")
                    .body(file.contents().to_vec())
                    .unwrap(),
                None => warp::http::Response::builder()
                    .status(500)
                    .body(b"Frontend not found".to_vec())
                    .unwrap(),
            },
        );

    let api_routes = create_room.or(inspect_room).with(cors);

    let routes = api_routes.or(ws_route).or(static_assets).or(index_html);

    warp::serve(routes).run(([0, 0, 0, 0], port)).await;
}

async fn handle_ws(ws: WebSocket, room_id: String, rooms: Rooms) {
    let id = room_id.trim().to_uppercase();

    {
        let mut map = rooms.write().await;
        if !map.contains_key(&id) {
            map.insert(
                id.clone(),
                Arc::new(Mutex::new(Room {
                    host: None,
                    guest: None,
                })),
            );
        }
    }

    let room = match rooms.read().await.get(&id).cloned() {
        Some(r) => r,
        None => return,
    };

    let (mut ws_tx, mut ws_rx) = ws.split();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Message>();

    let role: &str = {
        let mut r = room.lock().await;
        if r.host.is_none() {
            r.host = Some(tx.clone());
            "host"
        } else if r.guest.is_none() {
            r.guest = Some(tx.clone());
            "guest"
        } else {
            let _ = ws_tx
                .send(Message::text(
                    serde_json::json!({"type":"error","message":"Room is full"}).to_string(),
                ))
                .await;
            return;
        }
    };

    let _ = ws_tx
        .send(Message::text(
            serde_json::json!({"type":"role","role":role}).to_string(),
        ))
        .await;

    if role == "guest" {
        let r = room.lock().await;
        if let Some(host_tx) = &r.host {
            let _ = host_tx.send(Message::text(
                serde_json::json!({"type":"peer-status","status":"joined"}).to_string(),
            ));
        }
    }

    let is_host = role == "host";

    // Forward channel messages to WebSocket
    let forward_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_tx.send(msg).await.is_err() {
                break;
            }
        }
    });

    // Relay incoming messages to the other peer
    while let Some(result) = ws_rx.next().await {
        match result {
            Ok(msg) => {
                if msg.is_close() {
                    break;
                }
                if msg.is_text() {
                    let r = room.lock().await;
                    let other = if is_host { &r.guest } else { &r.host };
                    if let Some(other_tx) = other {
                        let _ = other_tx.send(msg);
                    }
                }
            }
            Err(_) => break,
        }
    }

    // Cleanup
    {
        let mut r = room.lock().await;
        let other = if is_host {
            r.host = None;
            &r.guest
        } else {
            r.guest = None;
            &r.host
        };
        if let Some(other_tx) = other {
            let _ = other_tx.send(Message::text(
                serde_json::json!({"type":"peer-status","status":"left"}).to_string(),
            ));
        }
    }

    {
        let r = room.lock().await;
        if r.host.is_none() && r.guest.is_none() {
            drop(r);
            rooms.write().await.remove(&id);
        }
    }

    forward_task.abort();
}
