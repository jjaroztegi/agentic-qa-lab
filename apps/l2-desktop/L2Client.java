// "Level 2 · Hot strip mill": Swing client of the mill's Level 2 system (stands in for a vendor's process-control desktop client).
// Coils and quality holds, thickness/width/flatness measurements, line stops and shift availability.
// Every business rule lives in the MES; this client only shows what the MES decides.
// Run (JDK 21, no build, no dependencies): java L2Client.java [MES_URL]   (operator id: env L2_OPERATOR)
// In the lab desktop image: l2-client <MES_URL> (same file, with the ATK accessibility bridge).
// Every interactive control has a stable accessible name: tests drive it by role + name through the OS
// accessibility tree. Choices are typeable or clickable (editable combos, text fields, radio/toggle buttons).
import java.awt.*;
import java.awt.event.*;
import java.net.URI;
import java.net.http.*;
import java.text.NumberFormat;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.List;
import java.util.function.Supplier;
import javax.swing.*;
import javax.swing.border.*;
import javax.swing.table.*;

public class L2Client {
    // Window title: catalog case CP-002 opens the client by this name.
    static final String TITLE = "Level 2 · Hot strip mill";
    static final Locale LOCALE = Locale.US;
    static final Color INK = new Color(0x1f2a30), MUTED = new Color(0x5a6872), OK = new Color(0x1e6b3a),
            HOLD = new Color(0x9a5a00), ERR = new Color(0xa8261c), BAR = new Color(0x263238);
    static Api api;
    static String operator = Optional.ofNullable(System.getenv("L2_OPERATOR")).orElse("OP0117");
    static JFrame frame;
    static final JLabel conn = new JLabel(), refreshed = new JLabel(), shiftLabel = new JLabel(), message = new JLabel(" ");
    static Map<String, Object> codes = Map.of();
    static CoilsTab coilsTab;

    public static void main(String[] args) {
        api = new Api(args.length > 0 ? args[0] : "http://127.0.0.1:13000");
        Locale.setDefault(LOCALE);
        JComponent.setDefaultLocale(LOCALE);
        UIManager.put("nimbusBase", new Color(0x4a5862));
        UIManager.put("nimbusBlueGrey", new Color(0xb7c1c8));
        UIManager.put("control", new Color(0xedf0f2));
        UIManager.put("nimbusSelectionBackground", new Color(0x2f5f80));
        UIManager.put("nimbusFocus", new Color(0x6b97b8));
        UIManager.put("defaultFont", new Font("DejaVu Sans", Font.PLAIN, 13));
        try {
            for (UIManager.LookAndFeelInfo i : UIManager.getInstalledLookAndFeels())
                if (i.getName().equals("Nimbus")) UIManager.setLookAndFeel(i.getClassName());
        } catch (Exception e) { System.err.println("Look and feel: " + e); }
        // Accessible action names are localized by the JVM locale; AT clients expect "click" whatever the host locale.
        UIManager.put("AbstractButton.clickText", "click");
        UIManager.put("ComboBox.togglePopupText", "togglePopup");
        SwingUtilities.invokeLater(L2Client::build);
    }

    static void build() {
        frame = new JFrame(TITLE);
        frame.getAccessibleContext().setAccessibleName(TITLE);
        frame.setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        try { codes = api.obj(api.get("/api/codes")); } catch (Exception e) { say("MES unavailable: " + e.getMessage(), true); }

        // Screens: a bar of toggle buttons (also F1-F3) over a CardLayout. JTabbedPane tabs expose no click
        // action through the Java ATK bridge, so tests could not switch screens by role + name.
        CardLayout cards = new CardLayout();
        JPanel screens = new JPanel(cards);
        JPanel nav = new JPanel(new FlowLayout(FlowLayout.LEFT, 4, 6));
        nav.setBorder(new CompoundBorder(new MatteBorder(0, 0, 1, 0, new Color(0xb9c3ca)), new EmptyBorder(2, 6, 0, 6)));
        ButtonGroup group = new ButtonGroup();
        coilsTab = new CoilsTab();
        JComponent[] list = {coilsTab, new MeasureTab(), new StopsTab()};
        String[] names = {"Coils", "Measurements", "Stops"};
        for (int i = 0; i < list.length; i++) {
            JComponent screen = list[i];
            String name = names[i];
            screens.add(screen, name);
            JToggleButton b = named(new JToggleButton(name + "   F" + (i + 1)), name);
            b.setFont(b.getFont().deriveFont(Font.BOLD));
            b.setSelected(i == 0);
            b.addActionListener(e -> {
                cards.show(screens, name);
                if (screen instanceof StopsTab st) st.reload();
            });
            group.add(b);
            nav.add(b);
            frame.getRootPane().registerKeyboardAction(e -> b.doClick(), KeyStroke.getKeyStroke(KeyEvent.VK_F1 + i, 0),
                    JComponent.WHEN_IN_FOCUSED_WINDOW);
        }
        JPanel center = new JPanel(new BorderLayout());
        center.add(nav, BorderLayout.NORTH);
        center.add(screens, BorderLayout.CENTER);

        frame.add(header(), BorderLayout.NORTH);
        frame.add(center, BorderLayout.CENTER);
        frame.add(statusBar(), BorderLayout.SOUTH);
        frame.setSize(1500, 900);
        frame.setLocationRelativeTo(null);
        frame.setExtendedState(JFrame.MAXIMIZED_BOTH);
        frame.setVisible(true);
        coilsTab.reload();
        new javax.swing.Timer(15_000, e -> { api.ping(); showShift(); }).start();
    }

    static JComponent header() {
        JPanel h = new JPanel(new BorderLayout());
        h.setBackground(BAR);
        h.setBorder(new EmptyBorder(10, 16, 10, 16));
        JLabel app = new JLabel("LEVEL 2 · HOT STRIP MILL");
        app.setFont(app.getFont().deriveFont(Font.BOLD, 18f));
        app.setForeground(Color.WHITE);
        JLabel sub = new JLabel("Finishing mill · Demo plant · Quality, measurements and stops");
        sub.setForeground(new Color(0xa9b7c0));
        JPanel left = new JPanel(new GridLayout(2, 1));
        left.setOpaque(false);
        left.add(app);
        left.add(sub);
        JPanel right = new JPanel(new FlowLayout(FlowLayout.RIGHT, 22, 6));
        right.setOpaque(false);
        JLabel line = new JLabel("Line: L2");
        JLabel op = new JLabel("Operator: " + operator);
        for (JLabel l : List.of(line, shiftLabel, op, conn, refreshed)) {
            l.setForeground(Color.WHITE);
            right.add(l);
        }
        showShift();
        setConnected(false);
        h.add(left, BorderLayout.WEST);
        h.add(right, BorderLayout.EAST);
        return h;
    }

    static JComponent statusBar() {
        JPanel s = new JPanel(new BorderLayout());
        s.setBorder(new CompoundBorder(new MatteBorder(1, 0, 0, 0, new Color(0xc5cdd3)), new EmptyBorder(4, 12, 4, 12)));
        JLabel url = new JLabel("MES " + api.base);
        url.setForeground(MUTED);
        s.add(message, BorderLayout.CENTER);
        s.add(url, BorderLayout.EAST);
        return s;
    }

    // --- shared state shown in header / status bar ---
    static void setConnected(boolean up) {
        conn.setText(up ? "● MES connected" : "● MES offline");
        conn.setForeground(up ? new Color(0x7fd69a) : new Color(0xff8a80));
        if (up) refreshed.setText("Updated " + LocalTime.now().withNano(0));
    }

    static void say(String text, boolean error) {
        message.setText(text);
        message.setForeground(error ? ERR : INK);
    }

    static void showShift() {
        Shift s = Shift.now();
        shiftLabel.setText("Shift: " + s.name() + " (" + s.hours() + ")");
    }

    // Shifts as the MES defines them (Morning 06-14, Afternoon 14-22, Night 22-06, dated on the day they start).
    // Codes M/T/N are MES API values.
    record Shift(String code, String name, String hours, LocalDate date) {
        static Shift of(String code, LocalDate date) {
            return switch (code) {
                case "M" -> new Shift("M", "Morning", "06:00–14:00", date);
                case "T" -> new Shift("T", "Afternoon", "14:00–22:00", date);
                default -> new Shift("N", "Night", "22:00–06:00", date);
            };
        }
        static Shift now() {
            LocalDateTime t = LocalDateTime.now();
            int h = t.getHour();
            return h < 6 ? of("N", t.toLocalDate().minusDays(1)) : of(h < 14 ? "M" : h < 22 ? "T" : "N", t.toLocalDate());
        }
    }

    @SuppressWarnings("unchecked")
    static List<String> codeList(String key) {
        return (List<String>) (List<?>) codes.getOrDefault(key, List.of());
    }

    // --- small UI helpers: every control gets its accessible name here ---
    static <T extends JComponent> T named(T c, String name) {
        c.getAccessibleContext().setAccessibleName(name);
        return c;
    }

    static JButton button(String name, Runnable action) {
        JButton b = named(new JButton(name), name);
        b.addActionListener(e -> action.run());
        return b;
    }

    static JTextField field(int cols, String name) {
        return named(new JTextField(cols), name);
    }

    static JLabel caption(String text, JComponent target) {
        JLabel l = new JLabel(text);
        l.setLabelFor(target);
        return l;
    }

    // Editable combo over a code list: the operator (or a test) can type the code or pick it.
    static JComboBox<String> codeCombo(String name, List<String> items) {
        JComboBox<String> c = named(new JComboBox<>(new Vector<>(items)), name);
        c.setEditable(true);
        c.setSelectedItem("");
        named((JComponent) c.getEditor().getEditorComponent(), name);
        c.setPrototypeDisplayValue("Thickness out of tolerance   ");
        return c;
    }

    /** Canonical code typed or picked in a code combo, or null when it is not in the list. */
    static String codeOf(JComboBox<String> c, List<String> items) {
        String v = String.valueOf(c.getEditor().getItem()).trim();
        return items.stream().filter(i -> i.equalsIgnoreCase(v)).findFirst().orElse(null);
    }

    static JTable table(String name, DefaultTableModel model) {
        JTable t = named(new JTable(model), name);
        t.setRowHeight(26);
        t.setSelectionMode(ListSelectionModel.SINGLE_SELECTION);
        t.setFillsViewportHeight(true);
        t.setShowGrid(true);
        t.setGridColor(new Color(0xdde3e7));
        t.setDefaultRenderer(Object.class, new Cells());
        t.getTableHeader().setReorderingAllowed(false);
        return t;
    }

    static void widths(JTable t, int... w) {
        for (int i = 0; i < w.length; i++) t.getColumnModel().getColumn(i).setPreferredWidth(w[i]);
    }

    static DefaultTableModel model(String... cols) {
        return new DefaultTableModel(cols, 0) {
            public boolean isCellEditable(int r, int c) { return false; }
        };
    }

    static JComponent section(String title, JComponent body) {
        JPanel p = new JPanel(new BorderLayout());
        TitledBorder b = BorderFactory.createTitledBorder(new MatteBorder(1, 0, 0, 0, new Color(0xb9c3ca)), title);
        b.setTitleFont(b.getTitleFont() == null ? new Font("DejaVu Sans", Font.BOLD, 13) : b.getTitleFont().deriveFont(Font.BOLD));
        b.setTitleColor(INK);
        p.setBorder(new CompoundBorder(b, new EmptyBorder(4, 2, 6, 2)));
        p.add(body);
        p.setOpaque(false);
        return p;
    }

    static String num(Object v, int decimals) {
        if (!(v instanceof Number n)) return "";
        NumberFormat f = NumberFormat.getNumberInstance(LOCALE);
        f.setMinimumFractionDigits(decimals);
        f.setMaximumFractionDigits(decimals);
        return f.format(n.doubleValue());
    }

    static String str(Map<String, Object> m, String k) {
        Object v = m.get(k);
        return v == null ? "" : v instanceof Double d && d == Math.floor(d) ? String.valueOf(d.longValue()) : String.valueOf(v);
    }

    /** MES timestamps are UTC ("YYYY-MM-DD HH:MM:SS"); shown in plant time. */
    static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm");

    static String localTime(String utc) {
        if (utc.isEmpty()) return "";
        return LocalDateTime.parse(utc.replace(' ', 'T')).atZone(ZoneOffset.UTC).withZoneSameInstant(ZoneId.systemDefault())
                .format(STAMP);
    }

    static class Cells extends DefaultTableCellRenderer {
        public Component getTableCellRendererComponent(JTable t, Object v, boolean sel, boolean focus, int r, int c) {
            super.getTableCellRendererComponent(t, v, sel, focus, r, c);
            setHorizontalAlignment(v instanceof Number ? RIGHT : LEFT);
            String col = t.getColumnName(c);
            if (v instanceof Double d)
                setText(num(d, col.startsWith("Weight") || col.startsWith("Duration") || col.startsWith("Width") ? 0 : col.startsWith("Flatness") ? 1 : 2));
            setFont(getFont().deriveFont(Font.PLAIN));
            if (!sel) setForeground(INK);
            String s = String.valueOf(v);
            if (!sel && (s.equals("HOLD") || s.equals("NOK"))) { setForeground(HOLD); setFont(getFont().deriveFont(Font.BOLD)); }
            if (!sel && s.equals("OK")) setForeground(OK);
            setBorder(new EmptyBorder(0, 6, 0, 6));
            return this;
        }
    }

    // Modal form: rows of (caption, control); Enter confirms; MES errors are shown inside the dialog.
    static class FormDialog extends JDialog {
        final JLabel error = new JLabel(" ");

        FormDialog(String title, String info, String confirmName, Object[][] rows, Supplier<String> onConfirm) {
            super(frame, title, true);
            getAccessibleContext().setAccessibleName(title);
            JPanel form = new JPanel(new GridBagLayout());
            form.setBorder(new EmptyBorder(14, 16, 6, 16));
            GridBagConstraints g = new GridBagConstraints();
            g.insets = new Insets(4, 4, 4, 4);
            g.anchor = GridBagConstraints.WEST;
            g.gridwidth = 2;
            JLabel head = new JLabel(info);
            head.setFont(head.getFont().deriveFont(Font.BOLD));
            form.add(head, g);
            g.gridwidth = 1;
            for (int i = 0; i < rows.length; i++) {
                JComponent c = (JComponent) rows[i][1];
                g.gridy = i + 1;
                g.gridx = 0; g.fill = GridBagConstraints.NONE; g.weightx = 0;
                form.add(caption((String) rows[i][0], c), g);
                g.gridx = 1; g.fill = GridBagConstraints.HORIZONTAL; g.weightx = 1;
                form.add(c, g);
            }
            g.gridy = rows.length + 1; g.gridx = 0; g.gridwidth = 2;
            error.setForeground(ERR);
            form.add(error, g);

            JButton ok = button(confirmName, () -> {
                String err = onConfirm.get();
                if (err == null) dispose(); else error.setText(err);
            });
            JButton cancel = button("Cancel", this::dispose);
            JPanel buttons = new JPanel(new FlowLayout(FlowLayout.RIGHT));
            buttons.add(ok);
            buttons.add(cancel);
            getRootPane().setDefaultButton(ok);
            getRootPane().registerKeyboardAction(e -> dispose(), KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0),
                    JComponent.WHEN_IN_FOCUSED_WINDOW);
            add(form, BorderLayout.CENTER);
            add(buttons, BorderLayout.SOUTH);
            pack();
            setMinimumSize(new Dimension(520, getHeight()));
            setLocationRelativeTo(frame);
            JComponent first = (JComponent) rows[0][1];
            Component focus = first instanceof JComboBox<?> cb ? cb.getEditor().getEditorComponent() : first;
            addWindowListener(new WindowAdapter() {
                public void windowOpened(WindowEvent e) { focus.requestFocusInWindow(); }
            });
        }
    }

    // ===================================================================== Coils
    static class CoilsTab extends JPanel {
        final DefaultTableModel model = model("ID", "Coil", "Order", "Customer", "Grade", "Nominal thickness (mm)", "Weight (kg)", "Status");
        final JTable table = table("Coils", model);
        final TableRowSorter<DefaultTableModel> sorter = new TableRowSorter<>(model);
        final JTextField filter = field(14, "Coil filter");
        final Map<String, JRadioButton> state = new LinkedHashMap<>(); // Status filter: "" = all
        final JLabel count = new JLabel();
        final Detail detail = new Detail();
        Map<String, Object> selected;

        CoilsTab() {
            super(new BorderLayout(0, 6));
            setBorder(new EmptyBorder(8, 8, 8, 8));
            JPanel bar = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 2));
            bar.add(caption("Coil / order:", filter));
            bar.add(filter);
            bar.add(new JLabel("Status:"));
            ButtonGroup group = new ButtonGroup();
            for (String[] o : new String[][]{{"", "All"}, {"OK", "Released (OK)"}, {"HOLD", "Held (HOLD)"}}) {
                JRadioButton b = named(new JRadioButton(o[1], o[0].isEmpty()), o[1]);
                b.addActionListener(e -> applyFilter());
                group.add(b);
                state.put(o[0], b);
                bar.add(b);
            }
            bar.add(button("Refresh", this::reload));
            bar.add(Box.createHorizontalStrut(24));
            bar.add(button("Hold", this::hold));
            bar.add(button("Release", this::release));
            bar.add(Box.createHorizontalStrut(24));
            count.setForeground(MUTED);
            bar.add(count);

            table.setRowSorter(sorter);
            table.removeColumn(table.getColumnModel().getColumn(0)); // ID stays in the model only
            widths(table, 130, 120, 230, 90, 150, 100, 80);
            filter.getDocument().addDocumentListener((SimpleDoc) this::applyFilter);
            table.getSelectionModel().addListSelectionListener(e -> { if (!e.getValueIsAdjusting()) showSelected(); });

            JSplitPane split = new JSplitPane(JSplitPane.HORIZONTAL_SPLIT, new JScrollPane(table), detail);
            split.setResizeWeight(1);
            split.setBorder(null);
            add(bar, BorderLayout.NORTH);
            add(split, BorderLayout.CENTER);
        }

        void applyFilter() {
            String q = filter.getText().trim().toLowerCase();
            String st = state.entrySet().stream().filter(e -> e.getValue().isSelected()).map(Map.Entry::getKey).findFirst().orElse("");
            sorter.setRowFilter(new RowFilter<>() {
                public boolean include(Entry<? extends DefaultTableModel, ? extends Integer> e) {
                    boolean text = q.isEmpty() || e.getStringValue(1).toLowerCase().contains(q) || e.getStringValue(2).toLowerCase().contains(q);
                    return text && (st.isEmpty() || st.equals(e.getStringValue(7)));
                }
            });
            showCount();
        }

        void showCount() {
            long held = 0;
            for (int i = 0; i < model.getRowCount(); i++) if ("HOLD".equals(model.getValueAt(i, 7))) held++;
            count.setText(table.getRowCount() + " of " + model.getRowCount() + " coils · held: " + held);
        }

        void reload() {
            String keep = selected == null ? null : str(selected, "id");
            try {
                List<Object> coils = api.list(api.get("/api/coils"));
                model.setRowCount(0);
                for (Object o : coils) {
                    Map<String, Object> c = api.obj(o);
                    model.addRow(new Object[]{str(c, "id"), str(c, "coil_no"), str(c, "erp_ref"), str(c, "customer"), str(c, "grade"),
                            c.get("thickness_mm"), c.get("weight_kg"), str(c, "quality")});
                }
                applyFilter();
                say(coils.size() + " coils read from the MES", false);
            } catch (Exception ex) {
                say("Error reading the MES: " + ex.getMessage(), true);
            }
            for (int i = 0; keep != null && i < table.getRowCount(); i++)
                if (keep.equals(model.getValueAt(table.convertRowIndexToModel(i), 0))) table.setRowSelectionInterval(i, i);
            if (table.getSelectedRow() < 0) showSelected();
        }

        void showSelected() {
            int row = table.getSelectedRow();
            selected = null;
            if (row >= 0) {
                try {
                    selected = api.obj(api.get("/api/coils/" + model.getValueAt(table.convertRowIndexToModel(row), 0)));
                } catch (Exception ex) {
                    say("Error reading the coil: " + ex.getMessage(), true);
                }
            }
            detail.fill(selected);
        }

        void hold() {
            if (selected == null) { say("Select a coil in the table", true); return; }
            List<String> motives = codeList("hold_motives");
            JComboBox<String> motive = codeCombo("Reason", motives);
            JTextField comment = field(28, "Comment");
            String coil = str(selected, "coil_no"), id = str(selected, "id");
            new FormDialog("Hold coil", "Coil " + coil + " · Order " + str(selected, "erp_ref") + " · " + str(selected, "grade"),
                    "Confirm hold", new Object[][]{{"Reason:", motive}, {"Comment:", comment}}, () -> {
                String m = codeOf(motive, motives);
                if (m == null) return "Choose a reason from the list";
                return post("/api/coils/" + id + "/hold", Map.of("motive", m, "comment", comment.getText(), "operator", operator),
                        "Coil " + coil + " held: " + m);
            }).setVisible(true);
        }

        void release() {
            if (selected == null) { say("Select a coil in the table", true); return; }
            List<String> motives = codeList("release_motives");
            JComboBox<String> motive = codeCombo("Reason", motives);
            JTextField supervisor = field(10, "Supervisor");
            JTextField comment = field(28, "Comment");
            String coil = str(selected, "coil_no"), id = str(selected, "id");
            new FormDialog("Release coil", "Coil " + coil + " · held for: " + str(selected, "hold_motive"),
                    "Confirm release", new Object[][]{{"Reason:", motive}, {"Supervisor no.:", supervisor}, {"Comment:", comment}}, () -> {
                String m = codeOf(motive, motives);
                if (m == null) return "Choose a reason from the list";
                return post("/api/coils/" + id + "/release",
                        Map.of("motive", m, "supervisor", supervisor.getText(), "comment", comment.getText(), "operator", operator),
                        "Coil " + coil + " released by " + supervisor.getText().trim().toUpperCase() + ": " + m);
            }).setVisible(true);
        }

        /** POST and refresh; returns the MES error text or null. */
        String post(String path, Map<String, Object> body, String done) {
            try {
                api.post(path, body);
            } catch (Exception ex) {
                return ex.getMessage();
            }
            reload();
            say(done, false);
            return null;
        }
    }

    interface SimpleDoc extends javax.swing.event.DocumentListener {
        void changed();
        default void insertUpdate(javax.swing.event.DocumentEvent e) { changed(); }
        default void removeUpdate(javax.swing.event.DocumentEvent e) { changed(); }
        default void changedUpdate(javax.swing.event.DocumentEvent e) { changed(); }
    }

    // Detail of the selected coil: data, tolerances, hold reason, measurement and quality history.
    static class Detail extends JPanel {
        final JLabel title = new JLabel("Select a coil");
        final JPanel facts = new JPanel(new GridBagLayout());
        final DefaultTableModel measures = model("Date", "Thickness", "Width", "Flatness", "Result");
        final DefaultTableModel events = model("Date", "Action", "Reason", "By", "Comment");

        Detail() {
            super(new BorderLayout(0, 8));
            setBorder(new EmptyBorder(0, 12, 0, 4));
            setPreferredSize(new Dimension(640, 400));
            title.setFont(title.getFont().deriveFont(Font.BOLD, 15f));
            facts.setOpaque(false);
            JPanel top = new JPanel(new BorderLayout(0, 6));
            top.add(title, BorderLayout.NORTH);
            top.add(facts, BorderLayout.CENTER);
            JPanel tables = new JPanel(new GridLayout(2, 1, 0, 8));
            JTable mt = table("Measurement history", measures), et = table("Quality history", events);
            widths(mt, 130, 80, 80, 80, 90);
            widths(et, 135, 65, 170, 85, 150);
            tables.add(section("Measurement history", new JScrollPane(mt)));
            tables.add(section("Quality history", new JScrollPane(et)));
            add(top, BorderLayout.NORTH);
            add(tables, BorderLayout.CENTER);
        }

        void fill(Map<String, Object> c) {
            facts.removeAll();
            measures.setRowCount(0);
            events.setRowCount(0);
            if (c == null) {
                title.setText("Select a coil");
            } else {
                title.setText("Detail · coil " + str(c, "coil_no"));
                Map<String, Object> l = c.get("limits") instanceof Map<?, ?> ? api.obj(c.get("limits")) : null;
                String held = "HOLD".equals(c.get("quality")) ? "HOLD · held" : "OK · released";
                Object[][] rows = {
                        {"Order / customer", str(c, "erp_ref") + " · " + str(c, "customer")},
                        {"Steel grade", str(c, "grade")},
                        {"Heat no.", str(c, "heat_no")},
                        {"Weight", num(c.get("weight_kg"), 0) + " kg"},
                        {"Nominal", num(c.get("thickness_mm"), 2) + " × " + num(c.get("width_mm"), 0) + " mm"},
                        {"Thickness tolerance", l == null ? "no specification" : range(l, "thickness_mm", 2, "mm")},
                        {"Width tolerance", l == null ? "no specification" : range(l, "width_mm", 0, "mm")},
                        {"Max. flatness", l == null ? "no specification" : "≤ " + num(api.list(l.get("flatness_iu")).get(1), 0) + " I"},
                        {"Status", held},
                        {"Hold reason", c.get("hold_motive") == null ? "—" : str(c, "hold_motive")},
                };
                GridBagConstraints g = new GridBagConstraints();
                g.anchor = GridBagConstraints.WEST;
                g.insets = new Insets(1, 0, 1, 16);
                for (Object[] r : rows) {
                    JLabel k = new JLabel((String) r[0]);
                    k.setForeground(MUTED);
                    JLabel v = new JLabel((String) r[1]);
                    if (r[0].equals("Status") || r[0].equals("Hold reason"))
                        v.setForeground("HOLD".equals(c.get("quality")) ? HOLD : OK);
                    g.gridy++;
                    g.gridx = 0; g.weightx = 0;
                    facts.add(k, g);
                    g.gridx = 1; g.weightx = 1;
                    facts.add(v, g);
                }
                for (Object o : api.list(c.get("measurements"))) {
                    Map<String, Object> m = api.obj(o);
                    measures.addRow(new Object[]{localTime(str(m, "created_at")), m.get("thickness_mm"), m.get("width_mm"),
                            m.get("flatness_iu"), str(m, "result")});
                }
                for (Object o : api.list(c.get("events"))) {
                    Map<String, Object> e = api.obj(o);
                    String by = e.get("supervisor") != null ? "Sup. " + str(e, "supervisor") : str(e, "operator");
                    events.addRow(new Object[]{localTime(str(e, "created_at")), "HOLD".equals(e.get("action")) ? "Hold" : "Release",
                            str(e, "motive"), by, str(e, "comment")});
                }
            }
            facts.revalidate();
            facts.repaint();
        }
    }

    static String range(Map<String, Object> limits, String key, int dec, String unit) {
        List<Object> r = api.list(limits.get(key));
        return num(r.get(0), dec) + " – " + num(r.get(1), dec) + " " + unit;
    }

    // ===================================================================== Measurements
    static class MeasureTab extends JPanel {
        final JTextField coilNo = field(14, "Coil to measure");
        final JTextField thickness = field(8, "Measured thickness (mm)");
        final JTextField width = field(8, "Measured width (mm)");
        final JTextField flatness = field(8, "Measured flatness (I)");
        final JLabel coilInfo = new JLabel("Type or scan the coil number and press Load coil");
        final JLabel tLim = new JLabel("—"), wLim = new JLabel("—"), fLim = new JLabel("—");
        final JLabel result = new JLabel(" ");
        final DefaultTableModel model = model("Date", "Thickness (mm)", "Width (mm)", "Flatness (I)", "Result", "Detail", "Operator");
        Map<String, Object> coil;

        MeasureTab() {
            super(new BorderLayout(12, 0));
            setBorder(new EmptyBorder(12, 12, 12, 12));
            JPanel form = new JPanel(new GridBagLayout());
            GridBagConstraints g = new GridBagConstraints();
            g.insets = new Insets(5, 4, 5, 4);
            g.anchor = GridBagConstraints.WEST;
            int y = 0;
            g.gridy = y++; g.gridx = 0; form.add(caption("Coil:", coilNo), g);
            g.gridx = 1; form.add(coilNo, g);
            g.gridx = 2; form.add(button("Load coil", this::load), g);
            coilNo.addActionListener(e -> load());
            g.gridy = y++; g.gridx = 0; g.gridwidth = 3;
            coilInfo.setForeground(MUTED);
            form.add(coilInfo, g);
            g.gridy = y++; g.gridwidth = 1;
            for (String[] h : new String[][]{{"1", "Measured value"}, {"2", "Specification limits (MES)"}}) {
                JLabel l = new JLabel(h[1]);
                l.setFont(l.getFont().deriveFont(Font.BOLD));
                g.gridx = Integer.parseInt(h[0]);
                form.add(l, g);
            }
            Object[][] rows = {{"Thickness (mm):", thickness, tLim}, {"Width (mm):", width, wLim}, {"Flatness (I):", flatness, fLim}};
            for (Object[] r : rows) {
                g.gridy = y++;
                g.gridx = 0; form.add(caption((String) r[0], (JComponent) r[1]), g);
                g.gridx = 1; form.add((JComponent) r[1], g);
                g.gridx = 2; form.add((JComponent) r[2], g);
                ((JTextField) r[1]).addActionListener(e -> register());
            }
            g.gridy = y++; g.gridx = 1; g.gridwidth = 2;
            form.add(button("Register measurement", this::register), g);
            g.gridy = y++; g.gridx = 0; g.gridwidth = 3;
            result.setFont(result.getFont().deriveFont(Font.BOLD, 14f));
            form.add(result, g);
            g.gridy = y; g.weighty = 1;
            form.add(Box.createVerticalGlue(), g);

            JPanel left = new JPanel(new BorderLayout());
            left.add(section("Measurement at line exit", form), BorderLayout.NORTH);
            left.setPreferredSize(new Dimension(560, 400));
            add(left, BorderLayout.WEST);
            add(section("Coil measurements", new JScrollPane(table("Coil measurements", model))), BorderLayout.CENTER);
        }

        void load() {
            String no = coilNo.getText().trim();
            coil = null;
            model.setRowCount(0);
            for (JLabel l : List.of(tLim, wLim, fLim)) l.setText("—");
            result.setText(" ");
            try {
                for (Object o : api.list(api.get("/api/coils")))
                    if (no.equalsIgnoreCase(str(api.obj(o), "coil_no"))) coil = api.obj(api.get("/api/coils/" + str(api.obj(o), "id")));
            } catch (Exception ex) {
                say("Error reading the MES: " + ex.getMessage(), true);
                return;
            }
            if (coil == null) {
                coilInfo.setText("Coil " + no + " does not exist in the MES");
                coilInfo.setForeground(ERR);
                return;
            }
            coilInfo.setForeground(INK);
            coilInfo.setText("Order " + str(coil, "erp_ref") + " · " + str(coil, "grade") + " · nominal " + num(coil.get("thickness_mm"), 2)
                    + " × " + num(coil.get("width_mm"), 0) + " mm · status " + str(coil, "quality"));
            if (coil.get("limits") instanceof Map<?, ?>) {
                Map<String, Object> l = api.obj(coil.get("limits"));
                tLim.setText(range(l, "thickness_mm", 2, "mm"));
                wLim.setText(range(l, "width_mm", 0, "mm"));
                fLim.setText("≤ " + num(api.list(l.get("flatness_iu")).get(1), 0) + " I");
            } else {
                coilInfo.setText(coilInfo.getText() + " · grade has no specification");
            }
            for (Object o : api.list(coil.get("measurements"))) {
                Map<String, Object> m = api.obj(o);
                model.addRow(new Object[]{localTime(str(m, "created_at")), m.get("thickness_mm"), m.get("width_mm"), m.get("flatness_iu"),
                        str(m, "result"), str(m, "detail"), str(m, "operator")});
            }
            say("Coil " + no + " loaded", false);
            thickness.requestFocusInWindow();
        }

        void register() {
            if (coil == null) { say("Load the coil to measure first", true); return; }
            String no = str(coil, "coil_no");
            Map<String, Object> r;
            try {
                r = api.obj(api.post("/api/coils/" + str(coil, "id") + "/measurements", Map.of("thickness_mm", thickness.getText(),
                        "width_mm", width.getText(), "flatness_iu", flatness.getText(), "operator", operator)));
            } catch (Exception ex) {
                result.setForeground(ERR);
                result.setText(ex.getMessage());
                say("Measurement rejected by the MES", true);
                return;
            }
            for (JTextField f : List.of(thickness, width, flatness)) f.setText("");
            load();
            coilsTab.reload();
            if (Boolean.TRUE.equals(r.get("ok"))) {
                result.setForeground(OK);
                result.setText("Measurement within tolerance");
                say("Measurement within tolerance registered on " + no, false);
                return;
            }
            StringBuilder msg = new StringBuilder("The measurement of coil " + no + " is out of tolerance:\n");
            for (Object o : api.list(r.get("failures"))) msg.append("  • ").append(str(api.obj(o), "message")).append('\n');
            Map<String, Object> c = api.obj(r.get("coil"));
            msg.append(Boolean.TRUE.equals(r.get("held"))
                    ? "\nThe MES has HELD the coil. Reason: " + str(c, "hold_motive")
                    : "\nThe coil was already held (" + str(c, "hold_motive") + ").");
            result.setForeground(HOLD);
            result.setText("Out of tolerance · coil held: " + str(c, "hold_motive"));
            say("Measurement out of tolerance on " + no, true);
            JOptionPane.showMessageDialog(frame, msg.toString(), "Measurement out of tolerance", JOptionPane.WARNING_MESSAGE);
        }
    }

    // ===================================================================== Stops
    static class StopsTab extends JPanel {
        final Shift now = Shift.now();
        final JTextField date = field(10, "Date");
        final JTextField start = field(6, "Start time");
        final JTextField end = field(6, "End time");
        final JComboBox<String> reason = codeCombo("Stop reason", codeList("stop_reasons"));
        final JTextField comment = field(24, "Stop comment");
        final ButtonGroup shifts = new ButtonGroup();
        final Map<String, JRadioButton> shiftButtons = new LinkedHashMap<>();
        final DefaultTableModel model = model("Start", "End", "Duration (min)", "Reason", "Comment", "Operator");
        final JLabel availTitle = new JLabel(), availValue = new JLabel("—"), availDetail = new JLabel(" ");
        final JProgressBar availBar = named(new JProgressBar(0, 1000), "Shift availability");

        StopsTab() {
            super(new BorderLayout(0, 10));
            setBorder(new EmptyBorder(12, 12, 12, 12));
            date.setToolTipText("YYYY-MM-DD; empty = date of the current shift");
            JPanel form = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
            form.add(caption("Date (YYYY-MM-DD, empty = today):", date)); form.add(date);
            form.add(caption("Start (HH:mm):", start)); form.add(start);
            form.add(caption("End (HH:mm):", end)); form.add(end);
            form.add(caption("Reason:", reason)); form.add(reason);
            form.add(caption("Comment:", comment)); form.add(comment);
            form.add(button("Register stop", this::register));

            JPanel shiftBar = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
            shiftBar.add(new JLabel("Shift:"));
            for (String code : List.of("M", "T", "N")) {
                Shift s = Shift.of(code, now.date());
                JRadioButton b = named(new JRadioButton(s.name()), s.name());
                b.setSelected(code.equals(now.code()));
                b.addActionListener(e -> reload());
                shifts.add(b);
                shiftButtons.put(code, b);
                shiftBar.add(b);
            }
            shiftBar.add(button("Refresh stops", this::reload));

            JPanel avail = new JPanel(new GridLayout(4, 1, 0, 4));
            availTitle.setForeground(MUTED);
            availValue.setFont(availValue.getFont().deriveFont(Font.BOLD, 34f));
            availBar.setStringPainted(false);
            avail.add(availTitle);
            avail.add(availValue);
            avail.add(availBar);
            avail.add(availDetail);
            avail.setPreferredSize(new Dimension(360, 160));

            JPanel north = new JPanel(new GridLayout(2, 1));
            north.add(section("Register line stop", form));
            north.add(shiftBar);
            JPanel east = new JPanel(new BorderLayout());
            east.add(section("Shift availability", avail), BorderLayout.NORTH);
            east.setBorder(new EmptyBorder(0, 12, 0, 0));
            add(north, BorderLayout.NORTH);
            add(section("Stops of the day", new JScrollPane(table("Stops of the day", model))), BorderLayout.CENTER);
            add(east, BorderLayout.EAST);
            reload();
        }

        static String stamp(String t, LocalDate day) {
            LocalDateTime x = LocalDateTime.parse(t);
            return x.toLocalDate().equals(day) ? x.toLocalTime().toString() : x.format(STAMP);
        }

        String shiftCode() {
            return shiftButtons.entrySet().stream().filter(e -> e.getValue().isSelected()).map(Map.Entry::getKey).findFirst().orElse(now.code());
        }

        // Empty date = the current shift's date. Prefilled fields would force tests to clear them first.
        LocalDate day() {
            String t = date.getText().trim();
            return t.isEmpty() ? now.date() : LocalDate.parse(t);
        }

        void reload() {
            LocalDate d;
            try { d = day(); } catch (Exception ex) { say("Invalid date (YYYY-MM-DD)", true); return; }
            try {
                model.setRowCount(0);
                for (Object o : api.list(api.get("/api/stops?date=" + d))) {
                    Map<String, Object> s = api.obj(o);
                    long min = Duration.between(LocalDateTime.parse(str(s, "start_at")), LocalDateTime.parse(str(s, "end_at"))).toMinutes();
                    model.addRow(new Object[]{stamp(str(s, "start_at"), d), stamp(str(s, "end_at"), d), (double) min,
                            str(s, "reason"), str(s, "comment"), str(s, "operator")});
                }
                Map<String, Object> a = api.obj(api.get("/api/availability?date=" + d + "&shift=" + shiftCode()));
                double pct = ((Number) a.get("availability_pct")).doubleValue();
                availTitle.setText(str(a, "shift_name") + " shift · " + d);
                availValue.setText(num(pct, 1) + "%");
                availValue.setForeground(pct >= 90 ? OK : pct >= 75 ? HOLD : ERR);
                availBar.setValue((int) Math.round(pct * 10));
                availDetail.setText("Stops: " + str(a, "stop_min") + " min of " + str(a, "planned_min") + " min planned");
            } catch (Exception ex) {
                say("Error reading the MES: " + ex.getMessage(), true);
            }
        }

        void register() {
            List<String> reasons = codeList("stop_reasons");
            String r = codeOf(reason, reasons);
            LocalDateTime from, to;
            try {
                from = day().atTime(LocalTime.parse(start.getText().trim()));
                to = day().atTime(LocalTime.parse(end.getText().trim()));
            } catch (Exception ex) {
                say("Invalid date (YYYY-MM-DD) or time (HH:mm)", true);
                return;
            }
            if (!to.isAfter(from)) to = to.plusDays(1); // a stop ending earlier than it starts ends the next day
            if (r == null) { say("Choose a stop reason from the list", true); return; }
            try {
                api.post("/api/stops", Map.of("start_at", from.toString(), "end_at", to.toString(), "reason", r,
                        "comment", comment.getText(), "operator", operator));
            } catch (Exception ex) {
                say("Stop rejected by the MES: " + ex.getMessage(), true);
                return;
            }
            say("Stop registered: " + from.toLocalTime() + "–" + to.toLocalTime() + " " + r, false);
            start.setText("");
            end.setText("");
            comment.setText("");
            reason.getEditor().setItem("");
            reload();
        }
    }

    // ===================================================================== MES API
    static class Api {
        final String base;
        final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

        Api(String base) { this.base = base.replaceAll("/+$", ""); }

        Object get(String path) throws Exception { return send(HttpRequest.newBuilder(URI.create(base + path)).GET()); }

        Object post(String path, Map<String, Object> body) throws Exception {
            return send(HttpRequest.newBuilder(URI.create(base + path)).header("content-type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(Json.write(body))));
        }

        Object send(HttpRequest.Builder req) throws Exception {
            HttpResponse<String> r;
            try {
                r = http.send(req.timeout(Duration.ofSeconds(8)).build(), HttpResponse.BodyHandlers.ofString());
            } catch (Exception ex) {
                setConnected(false);
                throw new Exception("no connection to the MES");
            }
            setConnected(true);
            Object body = r.body().isBlank() ? null : Json.parse(r.body());
            if (r.statusCode() >= 400) {
                Map<String, Object> m = body instanceof Map<?, ?> ? obj(body) : Map.of();
                Object errs = m.containsKey("errors") ? String.join("; ", list(m.get("errors")).stream().map(String::valueOf).toList()) : m.get("error");
                throw new Exception(errs != null ? String.valueOf(errs) : "error " + r.statusCode());
            }
            return body;
        }

        void ping() {
            http.sendAsync(HttpRequest.newBuilder(URI.create(base + "/health")).timeout(Duration.ofSeconds(4)).build(),
                    HttpResponse.BodyHandlers.discarding())
                    .whenComplete((r, ex) -> SwingUtilities.invokeLater(() -> setConnected(ex == null && r.statusCode() == 200)));
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> obj(Object o) { return (Map<String, Object>) o; }

        @SuppressWarnings("unchecked")
        List<Object> list(Object o) { return o == null ? List.of() : (List<Object>) o; }
    }

    // Minimal JSON reader/writer (the MES API is the only peer; no dependencies on purpose).
    static class Json {
        final String s;
        int i;

        Json(String s) { this.s = s; }

        static Object parse(String s) { return new Json(s).value(); }

        void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

        Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                Map<String, Object> m = new LinkedHashMap<>();
                i++;
                ws();
                if (s.charAt(i) == '}') { i++; return m; }
                do {
                    ws();
                    String k = string();
                    ws();
                    i++; // ':'
                    m.put(k, value());
                    ws();
                } while (s.charAt(i++) == ',');
                return m;
            }
            if (c == '[') {
                List<Object> l = new ArrayList<>();
                i++;
                ws();
                if (s.charAt(i) == ']') { i++; return l; }
                do { l.add(value()); ws(); } while (s.charAt(i++) == ',');
                return l;
            }
            if (c == '"') return string();
            if (s.startsWith("true", i)) { i += 4; return true; }
            if (s.startsWith("false", i)) { i += 5; return false; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int from = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            return Double.parseDouble(s.substring(from, i));
        }

        String string() {
            StringBuilder b = new StringBuilder();
            i++; // opening quote
            for (char c; (c = s.charAt(i++)) != '"'; ) {
                if (c != '\\') { b.append(c); continue; }
                char e = s.charAt(i++);
                switch (e) {
                    case 'n' -> b.append('\n');
                    case 't' -> b.append('\t');
                    case 'r' -> b.append('\r');
                    case 'b' -> b.append('\b');
                    case 'f' -> b.append('\f');
                    case 'u' -> { b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                    default -> b.append(e);
                }
            }
            return b.toString();
        }

        static String write(Map<String, Object> m) {
            StringBuilder b = new StringBuilder("{");
            for (Map.Entry<String, Object> e : m.entrySet()) {
                if (b.length() > 1) b.append(',');
                b.append(quote(e.getKey())).append(':');
                Object v = e.getValue();
                b.append(v == null ? "null" : v instanceof Number || v instanceof Boolean ? v.toString() : quote(v.toString()));
            }
            return b.append('}').toString();
        }

        static String quote(String v) {
            StringBuilder b = new StringBuilder("\"");
            for (char c : v.toCharArray()) {
                if (c == '"' || c == '\\') b.append('\\').append(c);
                else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                else b.append(c);
            }
            return b.append('"').toString();
        }
    }
}
