package com.voxden.android.flowbar;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Plain framework views with real text fields: a normal field, a password field, a multi-line field
 * and a label that is not editable. Written in Java on purpose: it runs in the test package's own
 * process, which has no Kotlin runtime.
 *
 * Extras: theme=light|dark (white or black background, to check the flow bar's rim on both),
 * focus=plain|password|multi|none, plainText / multiText (initial contents), plainSel / multiSel
 * (initial cursor position).
 */
public class FlowBarTestActivity extends Activity {
    private EditText chosen;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        boolean dark = !"light".equals(getIntent().getStringExtra("theme"));
        int background = dark ? Color.BLACK : Color.WHITE;
        int foreground = dark ? Color.WHITE : Color.BLACK;
        float density = getResources().getDisplayMetrics().density;
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setBackgroundColor(background);
        column.setPadding((int) (20 * density), (int) (56 * density), (int) (20 * density), (int) (20 * density));

        TextView label = new TextView(this);
        label.setText("Flow bar test screen");
        label.setTextColor(foreground);
        label.setTextSize(20f);
        EditText plain = field("Message", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES, foreground);
        EditText password = field("Password", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, foreground);
        EditText multi = field("Notes", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE, foreground);
        for (android.view.View view : new android.view.View[] {label, plain, password, multi}) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
            params.bottomMargin = (int) (16 * density);
            column.addView(view, params);
        }
        setContentView(column);

        String plainText = getIntent().getStringExtra("plainText");
        if (plainText != null) { plain.setText(plainText); plain.setSelection(getIntent().getIntExtra("plainSel", plainText.length())); }
        String multiText = getIntent().getStringExtra("multiText");
        if (multiText != null) { multi.setText(multiText); multi.setSelection(getIntent().getIntExtra("multiSel", multiText.length())); }

        String focus = getIntent().getStringExtra("focus");
        chosen = "password".equals(focus) ? password : "multi".equals(focus) ? multi : "none".equals(focus) ? null : plain;
        if (chosen != null) chosen.requestFocus();
    }

    /**
     * The keyboard is asked for once the window really has focus, and again every 400 ms until it is up
     * (a request made while the previous screen's keyboard is still going away can be swallowed).
     */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        final EditText target = chosen;
        if (!hasFocus || target == null) return;
        final long giveUp = android.os.SystemClock.uptimeMillis() + 8000;
        Runnable show = new Runnable() {
            @Override public void run() {
                android.view.WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
                boolean up = insets != null && insets.isVisible(android.view.WindowInsets.Type.ime());
                if (up || android.os.SystemClock.uptimeMillis() > giveUp) return;
                target.requestFocus();
                getSystemService(InputMethodManager.class).showSoftInput(target, 0);
                target.postDelayed(this, 400);
            }
        };
        target.post(show);
    }

    private EditText field(String hint, int inputType, int foreground) {
        EditText field = new EditText(this);
        field.setHint(hint);
        field.setInputType(inputType);
        field.setTextColor(foreground);
        field.setHintTextColor(Color.GRAY);
        field.setContentDescription(hint);
        return field;
    }
}
